/**
 * PDF 阅读器：左边是文档列表 + 自动目录，右边按需画出原页面。
 *
 * 正文刻意**不做文字重排**，直接用 pdf.js 把原页面渲染出来。重排的账之前算过一次：
 * 段落要按页猜行距、标题要按字号归类，换个排版就崩，最后只能一页页调参。
 * 画原页则任何版式都不会走样，顺带还能选中复制。
 *
 * 页面按需渲染：一屏只画视口附近的几页，画过的留一个上限（MAX_LIVE），超了就把
 * 离当前页最远的放掉。405 页的书开着也只占十几张画布的内存。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  GlobalWorkerOptions,
  TextLayer,
  getDocument,
  setLayerDimensions,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import {
  deletePdf,
  fetchPdfToc,
  fetchPdfBytes,
  fetchPdfs,
  savePdfToc,
  uploadPdf,
  type PdfMeta,
  type PdfTocNode,
} from '../api/pdf'
import { inferToc, outlineToc } from '../lib/pdfOutline'
import './PdfReader.css'

// worker 同源加载。交给 pdf.js 自己猜路径，在 Electron 的 file:// 下会 404
GlobalWorkerOptions.workerSrc = workerUrl

/** 同时留着的画布上限，再多在 405 页的书上就顶内存了 */
const MAX_LIVE = 24

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 「适应宽度」的上限：再大就比原始尺寸还大了 */
const MAX_FIT_SCALE = 1

/** 单页画布的像素上限（同 pdf.js 默认 maxCanvasPixels 的一半）：放到 400% 再乘 dpr 会吃掉几百 MB */
const MAX_CANVAS_PIXELS = 2 ** 24

/** 画布相对 CSS 像素的放大倍数：跟屏幕 dpr 走，超过像素上限就往回压 */
function pixelRatio(cssW: number, cssH: number): number {
  const dpr = window.devicePixelRatio || 1
  const cap = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, cssW * cssH))
  return Math.max(1, Math.min(dpr, cap))
}

/** 缩放比较用的小数位：scale 由一串浮点运算推出来，直接比会差最后一位 */
function sameScale(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.001
}

function countNodes(nodes: PdfTocNode[]): number {
  let n = nodes.length
  for (const node of nodes) if (node.children) n += countNodes(node.children)
  return n
}

/**
 * 默认展开哪些。条目少（手册、论文）就整个摊开，省得一条条点开；
 * 条目多（几百节的书）只开第一节，否则进来就是一屏目录墙。
 */
function defaultOpen(nodes: PdfTocNode[]): Set<string> {
  if (countNodes(nodes) <= 80) return new Set(nodes.map((_, i) => String(i)))
  return new Set(nodes.length > 0 ? ['0'] : [])
}

/** 过滤目录：父节点只为带出命中项而留 */
function filterToc(nodes: PdfTocNode[], q: string): PdfTocNode[] {
  if (!q) return nodes
  const needle = q.toLowerCase()
  const out: PdfTocNode[] = []
  for (const node of nodes) {
    const kids = node.children ? filterToc(node.children, q) : []
    if (node.title.toLowerCase().includes(needle) || kids.length > 0) {
      out.push({ ...node, children: kids.length > 0 ? kids : undefined })
    }
  }
  return out
}

/** 过滤态下目录整棵展开，不然命中项藏在收起的父节点里看不见 */
function allKeys(nodes: PdfTocNode[], prefix: string): string[] {
  const out: string[] = []
  nodes.forEach((node, i) => {
    const key = `${prefix}${i}`
    out.push(key)
    if (node.children) out.push(...allKeys(node.children, `${key}-`))
  })
  return out
}

function TocTree({
  nodes,
  open,
  activeKey,
  prefix,
  onToggle,
  onPick,
}: {
  nodes: PdfTocNode[]
  open: Set<string>
  activeKey: string
  prefix: string
  onToggle: (key: string) => void
  onPick: (node: PdfTocNode) => void
}) {
  return (
    <ul className="pdfr-toc">
      {nodes.map((node, i) => {
        const key = `${prefix}${i}`
        const kids = node.children ?? []
        const expanded = open.has(key)
        return (
          <li key={key}>
            <div className={activeKey === key ? 'pdfr-toc__row pdfr-toc__row--on' : 'pdfr-toc__row'}>
              {kids.length > 0 ? (
                <button
                  type="button"
                  className="pdfr-toc__chev"
                  aria-label={expanded ? '收起' : '展开'}
                  onClick={() => onToggle(key)}
                >
                  <span className={expanded ? 'pdfr-chev pdfr-chev--open' : 'pdfr-chev'} />
                </button>
              ) : (
                <span className="pdfr-toc__dot" />
              )}
              <button
                type="button"
                className="pdfr-toc__title"
                title={`${node.title}（第 ${node.page} 页）`}
                onClick={() => onPick(node)}
              >
                {node.title}
              </button>
              <span className="pdfr-toc__page">{node.page}</span>
            </div>
            {kids.length > 0 && expanded ? (
              <TocTree
                nodes={kids}
                open={open}
                activeKey={activeKey}
                prefix={`${key}-`}
                onToggle={onToggle}
                onPick={onPick}
              />
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

export function PdfReader() {
  const [list, setList] = useState<PdfMeta[]>([])
  const [id, setId] = useState('')
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [base, setBase] = useState({ w: 0, h: 0 })
  const [zoom, setZoom] = useState(1)
  const [wrapW, setWrapW] = useState(0)
  const [toc, setToc] = useState<PdfTocNode[]>([])
  const [tocFrom, setTocFrom] = useState<'outline' | 'infer' | ''>('')
  const [tocBusy, setTocBusy] = useState<{ done: number; total: number } | null>(null)
  const [tocQuery, setTocQuery] = useState('')
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [activePage, setActivePage] = useState(1)
  const [activeKey, setActiveKey] = useState('')
  /** 个别页跟第 1 页不一样大（横版插页），量到真实高度后按它排版 */
  const [heights, setHeights] = useState<Record<number, number>>({})
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  const bodyRef = useRef<HTMLDivElement | null>(null)
  const tocRef = useRef<HTMLDivElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const pageRefs = useRef(new Map<number, HTMLDivElement>())
  /** 每页正在跑的渲染任务；缩放一变就得取消重来，否则画布会错位 */
  const tasks = useRef(new Map<number, { cancel: () => void; scale: number }>())
  /** 页 → 已经按哪个 scale 画好了。不是 Set：换缩放时要知道旧的是多少 */
  const drawn = useRef(new Map<number, number>())
  /** 视口附近的页。滚动时靠它算当前页，缩放时靠它决定先重画谁 */
  const around = useRef(new Set<number>())
  const pdfRef = useRef<PDFDocumentProxy | null>(null)

  // 默认「适应宽度」，但最多按原始尺寸（100%）：宽屏下撑满整列字大得没法读
  const fitScale = base.w > 0 && wrapW > 0 ? Math.min(MAX_FIT_SCALE, (wrapW - 56) / base.w) : 1
  const scale = Math.max(0.1, Math.min(4, fitScale * zoom))

  useEffect(() => {
    pdfRef.current = doc
  }, [doc])

  /* ------------------------------- 列表与选择 ------------------------------- */

  useEffect(() => {
    fetchPdfs()
      .then((pdfs) => {
        setList(pdfs)
        setId((prev) => prev || pdfs[0]?.id || '')
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  // 深链：#/documents?tab=pdf&id=xxx
  useEffect(() => {
    const onHash = () => {
      const next = new URLSearchParams(location.hash.split('?')[1] ?? '').get('id') ?? ''
      setId(next)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  /** 先看书签，没有书签再按版式推；推出来的结果 PUT 回服务端缓存，下次打开秒开 */
  const buildToc = useCallback(
    async (pdf: PDFDocumentProxy, pdfId: string, isCancelled: () => boolean) => {
      let nodes = await outlineToc(pdf)
      let source: 'outline' | 'infer' = 'outline'
      if (isCancelled()) return
      if (nodes.length === 0) {
        source = 'infer'
        setTocBusy({ done: 0, total: pdf.numPages })
        try {
          nodes = await inferToc(pdf, (done, total) => setTocBusy({ done, total }))
        } finally {
          setTocBusy(null)
        }
      }
      if (isCancelled()) return
      setToc(nodes)
      setTocFrom(nodes.length > 0 ? source : '')
      setOpen(defaultOpen(nodes))
      try {
        await savePdfToc(pdfId, { source, nodes, pages: pdf.numPages })
        setList((prev) =>
          prev.map((p) =>
            p.id === pdfId
              ? {
                  ...p,
                  hasToc: nodes.length > 0,
                  tocSource: nodes.length > 0 ? source : null,
                  tocRoots: nodes.length,
                  pages: pdf.numPages,
                }
              : p,
          ),
        )
      } catch {
        // 缓存写不上不影响这次阅读，下次重算一遍就是了
      }
    },
    [],
  )

  /* --------------------------------- 打开文件 -------------------------------- */

  useEffect(() => {
    if (!id) {
      setDoc(null)
      return
    }
    let cancelled = false
    // 销毁要走 loadingTask：PDFDocumentProxy 上没有 destroy
    let loading: PDFDocumentLoadingTask | null = null
    // 下面这几个 Map/Set 的引用一旦建好就不再换，先取出来，清理时不必再读 ref
    const runningTasks = tasks.current
    const drawnPages = drawn.current
    const aroundPages = around.current
    setLoading(true)
    setError('')
    setToc([])
    setTocFrom('')
    setHeights({})
    setActivePage(1)
    setPageCount(0)
    setBase({ w: 0, h: 0 })
    drawnPages.clear()
    aroundPages.clear()

    const run = async () => {
      const bytes = await fetchPdfBytes(id)
      if (cancelled) return
      loading = getDocument({ data: bytes })
      const pdf = await loading.promise
      if (cancelled) {
        void loading.destroy()
        return
      }
      setDoc(pdf)
      setPageCount(pdf.numPages)
      const first = await pdf.getPage(1)
      const vp = first.getViewport({ scale: 1 })
      if (cancelled) return
      setBase({ w: vp.width, h: vp.height })

      if (list.find((p) => p.id === id)?.hasToc) {
        const cached = await fetchPdfToc(id)
        if (cancelled) return
        if (cached && cached.nodes.length > 0) {
          setToc(cached.nodes)
          setTocFrom(cached.source)
          setOpen(defaultOpen(cached.nodes))
          return
        }
      }
      await buildToc(pdf, id, () => cancelled)
    }

    run()
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
      setDoc(null)
      for (const t of runningTasks.values()) t.cancel()
      runningTasks.clear()
      drawnPages.clear()
      aroundPages.clear()
      if (loading) void loading.destroy()
    }
    // list 只在这里读一次「有没有缓存」，不该因为它更新就把整本书重新加载一遍
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  /* -------------------------------- 页面渲染 -------------------------------- */

  const release = useCallback((pno: number) => {
    tasks.current.get(pno)?.cancel()
    tasks.current.delete(pno)
    drawn.current.delete(pno)
    pageRefs.current.get(pno)?.replaceChildren()
  }, [])

  /** 画布留着有上限：超了先放掉离当前页最远的那些 */
  const trimLive = useCallback(
    (center: number) => {
      if (drawn.current.size <= MAX_LIVE) return
      const far = [...drawn.current.keys()].sort(
        (a, b) => Math.abs(b - center) - Math.abs(a - center),
      )
      let over = drawn.current.size - MAX_LIVE
      for (const pno of far) {
        if (over <= 0) break
        if (around.current.has(pno)) continue
        release(pno)
        over -= 1
      }
    },
    [release],
  )

  const renderPage = useCallback(
    async (pno: number) => {
      const pdf = pdfRef.current
      const el = pageRefs.current.get(pno)
      if (!pdf || !el) return
      const running = tasks.current.get(pno)
      if (running && sameScale(running.scale, scale)) return
      if (!running && drawn.current.has(pno) && sameScale(drawn.current.get(pno) ?? 0, scale)) {
        return
      }
      running?.cancel()

      const page = await pdf.getPage(pno)
      const viewport = page.getViewport({ scale })
      // 画布按物理像素画，CSS 尺寸仍是 viewport（.pdfr-page__canvas 撑满页框）。
      // 只按 CSS 像素画的话 Retina 上 1 个像素被拉成 2×2，缩小后尤其糊
      const outputScale = pixelRatio(viewport.width, viewport.height)
      // 页框宽高是取整的（见渲染处的 style），画布像素必须正好是「页框 × dpr」：
      // 差一个像素浏览器就得把整张画布重采样一遍，整页都会发虚
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(Math.floor(viewport.width) * outputScale)
      canvas.height = Math.round(Math.floor(viewport.height) * outputScale)
      canvas.className = 'pdfr-page__canvas'
      const textLayer = document.createElement('div')
      textLayer.className = 'pdfr-page__text'
      el.replaceChildren(canvas, textLayer)

      const task = page.render({
        canvas,
        viewport,
        // 按画布实际像素反推比例，取整掉的那零点几像素也一并吸收，内容正好铺满画布
        transform: [canvas.width / viewport.width, 0, 0, canvas.height / viewport.height, 0, 0],
      })
      const entry = { scale, cancel: () => task.cancel() }
      tasks.current.set(pno, entry)

      try {
        await task.promise
        if (tasks.current.get(pno) !== entry) return
        setLayerDimensions(textLayer, viewport)
        const layer = new TextLayer({
          textContentSource: page.streamTextContent(),
          container: textLayer,
          viewport,
        })
        await layer.render()
        if (tasks.current.get(pno) !== entry) return
        tasks.current.delete(pno)
        drawn.current.set(pno, scale)
        // 横版插页之类跟第 1 页不一样大，量到就按真实高度重排，否则会盖住下一页。
        // 存的是 scale=1 的高度：缩放一变这里的 px 就不对了
        if (Math.abs(el.offsetHeight - viewport.height) > 1) {
          setHeights((prev) => ({ ...prev, [pno]: viewport.height / scale }))
        }
        trimLive(pno)
      } catch (err) {
        // 翻页太快 / 缩放变了会把渲染取消，这属于正常流程，不弹错
        const name = err instanceof Error ? err.name : ''
        if (name === 'RenderingCancelledException' || /cancel/i.test(name)) return
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [scale, trimLive],
  )

  // 下面几个观察器/监听器只在挂载或缩放时重挂，渲染函数得从 ref 里拿最新的
  const renderRef = useRef(renderPage)
  renderRef.current = renderPage

  /** 视口附近的页才画。这个观察器不负责判断「当前在第几页」，滚动位置另算 */
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || !doc || base.w === 0) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pno = Number((entry.target as HTMLElement).dataset.page)
          if (!Number.isFinite(pno)) continue
          if (entry.isIntersecting) {
            around.current.add(pno)
            void renderRef.current(pno)
          } else {
            around.current.delete(pno)
          }
        }
      },
      // 上下各多画两屏，滚起来才不至于一路白屏
      { root: bodyRef.current, rootMargin: '200% 0px 200% 0px' },
    )
    for (const el of pageRefs.current.values()) io.observe(el)
    return () => io.disconnect()
  }, [doc, pageCount, base.w])

  /** 容器宽度决定「适应宽度」的比例 */
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(([entry]) => setWrapW(entry.contentRect.width))
    ro.observe(wrap)
    setWrapW(wrap.clientWidth)
    return () => ro.disconnect()
  }, [doc])

  /** 缩放变了：已画过的全部按新尺寸重来，视口外的直接放掉 */
  useEffect(() => {
    if (!doc || base.w === 0) return
    for (const pno of [...drawn.current.keys()]) {
      if (!around.current.has(pno)) release(pno)
    }
    for (const pno of around.current) void renderRef.current(pno)
  }, [scale, doc, base.w, release])

  /** 滚动时算当前在第几页：锚点落在哪一页的框里就是哪一页 */
  useEffect(() => {
    const body = bodyRef.current
    if (!body || !doc) return
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const anchor = body.getBoundingClientRect().top + 4
        let hit = 0
        let firstBelow = 0
        for (const pno of around.current) {
          const el = pageRefs.current.get(pno)
          if (!el) continue
          const rect = el.getBoundingClientRect()
          if (rect.top <= anchor && rect.bottom > anchor) {
            hit = pno
            break
          }
          if (rect.top > anchor && (firstBelow === 0 || pno < firstBelow)) firstBelow = pno
        }
        const next = hit || firstBelow
        if (next) setActivePage(next)
      })
    }
    body.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      body.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [doc])

  /** 滚到某一页的某个高度。y 是 PDF 用户空间坐标（原点左下），得转成视口里的偏移 */
  const jumpTo = useCallback(
    async (page: number, y: number) => {
      const el = pageRefs.current.get(page)
      const body = bodyRef.current
      if (!el || !body) return
      let inner = 0
      if (y > 0 && pdfRef.current) {
        const p = await pdfRef.current.getPage(page)
        const viewport = p.getViewport({ scale })
        const [, vy] = viewport.convertToViewportPoint(0, y)
        inner = Math.max(0, vy - 16)
      }
      const top =
        el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop
      body.scrollTo({ top: Math.max(0, top + inner - 12), behavior: 'smooth' })
    },
    [scale],
  )

  // 当前页变了就把目录高亮挪到它所属的那一节（目录顺序里最后一个「起始页 ≤ 当前页」的节点）
  useEffect(() => {
    if (toc.length === 0) return
    let key = ''
    let i = 0
    const walk = (nodes: PdfTocNode[], prefix: string) => {
      nodes.forEach((node, n) => {
        const k = `${prefix}${n}`
        if (node.page <= activePage) key = k
        i += 1
        if (node.children) walk(node.children, `${k}-`)
      })
    }
    walk(toc, '')
    if (!key || key === activeKey) return
    setActiveKey(key)
    // 高亮的那条可能在收起的分支里，顺手把祖先都展开
    setOpen((prev) => {
      const next = new Set(prev)
      const parts = key.split('-').filter(Boolean)
      let acc = ''
      for (const part of parts.slice(0, -1)) {
        acc = acc === '' ? part : `${acc}-${part}`
        next.add(acc)
      }
      return next
    })
  }, [activePage, toc, activeKey])

  /**
   * 高亮滚出目录框就把它带回来。这里不用 scrollIntoView：flex 布局下它会连
   * 外层的滚动容器一起滚，正文位置会被带偏；直接改自己的 scrollTop 最稳。
   */
  useEffect(() => {
    const box = tocRef.current
    const row = box?.querySelector('.pdfr-toc__row--on')
    if (!box || !row) return
    const r = row.getBoundingClientRect()
    const boxRect = box.getBoundingClientRect()
    if (r.top >= boxRect.top && r.bottom <= boxRect.bottom) return
    box.scrollTop += r.top - boxRect.top - (boxRect.height - r.height) / 2
  }, [activeKey])

  /* --------------------------------- 交互 ---------------------------------- */

  async function onUpload(file: File | undefined) {
    if (!file) return
    setUploading(true)
    setError('')
    try {
      const rec = await uploadPdf(file)
      setList(await fetchPdfs())
      location.hash = `#/documents?tab=pdf&id=${encodeURIComponent(rec.id)}`
      setId(rec.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
    }
  }

  async function onDelete(meta: PdfMeta) {
    if (!confirm(`从平台删掉《${meta.name}》？原文件会一起删。`)) return
    try {
      const pdfs = await deletePdf(meta.id)
      setList(pdfs)
      if (meta.id === id) {
        const next = pdfs[0]?.id ?? ''
        setId(next)
        location.hash = next
          ? `#/documents?tab=pdf&id=${encodeURIComponent(next)}`
          : '#/documents?tab=pdf'
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const visibleToc = useMemo(() => filterToc(toc, tocQuery.trim()), [toc, tocQuery])
  const current = list.find((p) => p.id === id)

  return (
    <div className="pdfr">
      <aside className="pdfr__nav">
        <label className={`pdfr__upload ${uploading ? 'pdfr__upload--busy' : ''}`}>
          {uploading ? '上传中…' : '＋ 上传 PDF'}
          <input
            type="file"
            accept="application/pdf,.pdf"
            hidden
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              void onUpload(file)
            }}
          />
        </label>

        {list.length > 0 ? (
          <ul className="pdfr__list">
            {list.map((meta) => (
              <li
                key={meta.id}
                className={meta.id === id ? 'pdfr__item pdfr__item--on' : 'pdfr__item'}
              >
                <button
                  type="button"
                  className="pdfr__open"
                  title={meta.name}
                  onClick={() => {
                    location.hash = `#/documents?tab=pdf&id=${encodeURIComponent(meta.id)}`
                    setId(meta.id)
                  }}
                >
                  <span className="pdfr__name">{meta.name}</span>
                  <span className="pdfr__meta">
                    {meta.pages > 0 ? `${meta.pages} 页 · ` : ''}
                    {formatBytes(meta.bytes)}
                    {meta.tocSource === 'outline'
                      ? ' · 书签目录'
                      : meta.hasToc
                        ? ' · 推断目录'
                        : ''}
                  </span>
                </button>
                <button
                  type="button"
                  className="pdfr__del"
                  title="删除"
                  onClick={() => void onDelete(meta)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="pdfr__empty">还没有 PDF。上传一份，目录会自动生成。</p>
        )}

        <div className="pdfr__toc-head">
          <input
            className="pdfr__search"
            value={tocQuery}
            onChange={(e) => setTocQuery(e.target.value)}
            placeholder="过滤目录"
          />
          <span className="pdfr__badge">
            {tocBusy
              ? `解析中 ${tocBusy.done}/${tocBusy.total}`
              : tocFrom === 'outline'
                ? '书签'
                : tocFrom === 'infer'
                  ? '按版式推断'
                  : '无目录'}
          </span>
        </div>

        {toc.length > 0 ? (
          <div className="pdfr__scroll" ref={tocRef}>
            <TocTree
              nodes={visibleToc}
              open={tocQuery.trim() ? new Set(allKeys(visibleToc, '')) : open}
              activeKey={activeKey}
              prefix=""
              onToggle={(key) =>
                setOpen((prev) => {
                  const next = new Set(prev)
                  if (next.has(key)) next.delete(key)
                  else next.add(key)
                  return next
                })
              }
              onPick={(node) => void jumpTo(node.page, node.y)}
            />
          </div>
        ) : loading || tocBusy ? null : id ? (
          <p className="pdfr__empty">这份 PDF 没有书签，按字号也没认出标题。</p>
        ) : null}
      </aside>

      <article className="pdfr__main">
        {error && <div className="error-banner">{error}</div>}
        {!id ? (
          <div className="pdfr__placeholder">
            <h2>PDF 阅读</h2>
            <p>
              上传 PDF 后左侧会生成目录，滚到哪一节目录就高亮到哪一节。
              带书签的用书签，没书签的按字号和版式推。
            </p>
          </div>
        ) : (
          <>
            <header className="pdfr__head">
              <div className="pdfr__title">
                <strong>{current?.name ?? '…'}</strong>
                <span>{pageCount > 0 ? `第 ${activePage} / ${pageCount} 页` : '读取中…'}</span>
              </div>
              <div className="pdfr__zoom">
                <button type="button" onClick={() => setZoom((z) => Math.max(0.5, z - 0.15))}>
                  −
                </button>
                <button type="button" className="pdfr__zoom-reset" onClick={() => setZoom(1)}>
                  {Math.round(scale * 100)}%
                </button>
                <button type="button" onClick={() => setZoom((z) => Math.min(4, z + 0.15))}>
                  ＋
                </button>
              </div>
            </header>
            <div className="pdfr__body" ref={bodyRef}>
              <div className="pdfr__wrap" ref={wrapRef}>
                {Array.from({ length: pageCount }, (_, i) => i + 1).map((pno) => (
                  <div
                    key={pno}
                    className="pdfr-page"
                    data-page={pno}
                    ref={(el) => {
                      if (el) pageRefs.current.set(pno, el)
                      else pageRefs.current.delete(pno)
                    }}
                    // 取整：小数宽度会让画布被拉伸重采样，跟 renderPage 里的画布尺寸一一对应
                    style={{
                      width: Math.floor(base.w * scale) || undefined,
                      height: Math.floor((heights[pno] ?? base.h) * scale) || undefined,
                    }}
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </article>
    </div>
  )
}
