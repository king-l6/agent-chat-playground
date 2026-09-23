/**
 * 带引用角标的 Markdown 渲染
 * - 从 search_notes 工具结果建 citation → 原文 映射
 * - 正文里的 [1][2] 渲染为可点击角标，点开看 title / id / snippet
 *
 * 必须挂 remark-gfm：不开 GFM 时表格会被当成普通段落，单元格之间的换行塌成空格，
 * 一整张表就挤成一行带竖线的文字（实测踩过）。文档页早有这个插件，聊天页漏了。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ToolCallView } from '../types'
import { ChatImage } from './ChatImage'
import {
  injectCitationAnchors,
  parseCitationHref,
  parseCitationHitsFromTools,
  type CitationHit,
} from '../lib/citations'
import './CitationMarkdown.css'

/**
 * 角标里点标题要能跳到来源文档，为的是核对「这条召回对不对」。
 *
 * wiki 文档的 docPath 是相对 WIKI_DIR 的路径，正好就是文档页 ?path= 要的形态；
 * 内置文档（项目说明、求职补充手册）没有原文文件，docPath 为空，退到向量库页按 docId 看块——
 * 至少能看到切出来的文本和向量，而不是给个点不动的标题。
 */
function docHref(hit: CitationHit): string | null {
  if (hit.docPath) return `#/documents?path=${encodeURIComponent(hit.docPath)}`
  if (hit.docId) return `#/vectors?doc=${encodeURIComponent(hit.docId)}`
  return null
}

/** 浮层在 fixed 坐标系里的落点；null = 还没量出来，先隐着别闪 */
type PopoverPos = { left: number; top: number }

/** 浮层挂到 body 上：`document.body` 在 SSR/测试环境可能没有，用前判一下 */
const PORTAL_HOST = typeof document === 'undefined' ? null : document.body

/** 单个角标；instanceKey 来自 href，重渲染后不变 */
function CitationLink({
  n,
  instanceKey,
  hit,
  openKey,
  setOpenKey,
}: {
  n: number
  instanceKey: string
  hit?: CitationHit
  openKey: string | null
  setOpenKey: (key: string | null) => void
}) {
  const open = openKey === instanceKey
  const href = hit ? docHref(hit) : null
  const wrapRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLSpanElement | null>(null)
  const [pos, setPos] = useState<PopoverPos | null>(null)

  /*
   * 浮层必须 portal 到 body、并改用 position: fixed。
   *
   * 原来它是 .cite-wrap 里的 absolute：角标经常落在 .msg__content table 的单元格里，
   * 而那张表是 `display:block; overflow-x:auto` 的滚动容器——按 CSS 规范，只写 overflow-x
   * 时 overflow-y 会被算成 auto，于是表在纵横两个方向都裁剪。实测就是浮层只露出左边一小条、
   * 剩下的正文糊在表格上（截图里表下那条横向滚动条就是这个滚动容器）。
   * 挂到 body 后，任何祖先的 overflow 都管不着它。
   */
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const anchor = wrapRef.current?.getBoundingClientRect()
    if (!anchor) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    // 宽度交给 CSS（min(320px, 80vw)），量完真实尺寸再夹回视口，避免小屏顶出去
    const box = panelRef.current?.getBoundingClientRect()
    const w = box?.width ?? 0
    const h = box?.height ?? 0
    const left = Math.min(Math.max(8, anchor.left), Math.max(8, vw - 8 - w))
    // 默认贴角标下方；下面放不下就翻到角标上方
    let top = anchor.bottom + 6
    if (h > 0 && top + h > vh - 8) top = anchor.top - 6 - h
    setPos({ left, top: Math.max(8, top) })
    // 依赖只有 open：位置只由「开没开 + 角标当下在哪」决定，命中内容变了不用重算
  }, [open])

  /*
   * 浮层打开期间收键盘和指针：
   * - Esc 关闭。挂 window 而不是浮层自己——用户开完角标鼠标常常已经移开、焦点也不在浮层里，
   *   挂在元素上按 Esc 没反应
   * - 滚动/改窗口就关。fixed 定位不会跟着表格滚，留着就是一条错位的浮层
   * - 点外面也关（浮层现在在 body 上，不是角标的子节点，得单独判一次）
   * 只有开着的那个角标会注册（openKey 全局唯一），没开的直接 return。
   */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenKey(null)
    }
    const onViewportChange = (e: Event) => {
      // 浮层自己内部滚（snippet 太长有 max-height）不算，否则鼠标一滚就没了
      if (e.type === 'scroll' && panelRef.current?.contains(e.target as Node)) return
      setOpenKey(null)
    }
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      // 点角标本身交给 onClick 去 toggle，这里只处理「点到别处」
      if (wrapRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpenKey(null)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onViewportChange)
    // scroll 不冒泡，必须用捕获阶段才收得到表格、主区里的滚动
    window.addEventListener('scroll', onViewportChange, true)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open, setOpenKey])

  const panel = open && (
    <span
      ref={panelRef}
      className={hit ? 'cite-popover' : 'cite-popover cite-popover--miss'}
      role="tooltip"
      style={{
        left: pos ? `${pos.left}px` : 0,
        top: pos ? `${pos.top}px` : 0,
        // 首次提交时还不知道落点，先占位但不可见（visibility 隐藏仍能量到尺寸），
        // 量完由 layout effect 同步写回 pos，浏览器不会画出跳一下的中间态
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {hit ? (
        <>
          {hit.docName && <span className="cite-popover__doc">{hit.docName}</span>}
          {href ? (
            <a className="cite-popover__title" href={href} title="打开来源文档核对这条召回">
              <strong>{hit.title}</strong>
              <span className="cite-popover__jump">打开来源 →</span>
            </a>
          ) : (
            <strong>{hit.title}</strong>
          )}
          <span className="cite-popover__meta">{hit.docPath || hit.id}</span>
          {/* 图片命中：角标点开就能看见引用的是哪张图，省得跳过去核对 */}
          {hit.imageUrl && <ChatImage src={hit.imageUrl} alt={hit.title} />}
          <div className="cite-popover__snippet">{hit.snippet}</div>
        </>
      ) : (
        <>引用 [{n}] 未在本轮 search_notes 结果中找到</>
      )}
    </span>
  )

  return (
    <span className="cite-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`cite-badge ${hit ? 'cite-badge--ok' : 'cite-badge--miss'}`}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpenKey(open ? null : instanceKey)
        }}
        title={
          hit
            ? `${hit.docName ? `${hit.docName} · ` : ''}${hit.title} (${hit.id})`
            : `引用 [${n}] 未找到`
        }
      >
        [{n}]
      </button>
      {panel && PORTAL_HOST ? createPortal(panel, PORTAL_HOST) : null}
    </span>
  )
}

export function CitationMarkdown({
  content,
  tools,
}: {
  content: string
  tools: ToolCallView[]
}) {
  const cites = useMemo(() => parseCitationHitsFromTools(tools), [tools])
  const processed = useMemo(() => injectCitationAnchors(content), [content])
  const [openKey, setOpenKey] = useState<string | null>(null)

  const components = useMemo(
    () => ({
      // 助手贴的原图（本地直出 /api/image/cache/...）在这里补 API base 并渲染
      img: ChatImage,
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
        if (href?.startsWith('#citation-')) {
          const parsed = parseCitationHref(href)
          if (!parsed) return <>{children}</>
          return (
            <CitationLink
              n={parsed.n}
              instanceKey={parsed.instanceKey}
              hit={cites.get(parsed.n)}
              openKey={openKey}
              setOpenKey={setOpenKey}
            />
          )
        }
        return (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        )
      },
    }),
    [cites, openKey],
  )

  return (
    <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
      {processed}
    </ReactMarkdown>
  )
}
