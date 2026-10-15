/**
 * 从 PDF 里抠出目录，两条路：
 *
 *   1. `getOutline()` —— PDF 自带书签。有就一定要用：那是作者写的，比任何推断都准。
 *   2. 没有书签就按版式推。教科书/电子书导出 PDF 时经常把书签丢了（比如那份
 *      405 页的面试指南，`getOutline()` 返回空数组），但标题的字号是实实在在留在页面上的。
 *
 * 推断这条路最反直觉的一点是**层级不能按字号大小排**。那份指南里一级标题 21pt、
 * 二级 24pt，按字号排会把层级排反；而按「这种字号在全文档出现多少次」排就正好：
 * 17 / 151 / 597 一一对上 21pt / 24pt / 15pt。出现得越少层级越高——这条在
 * 「章少节多」的文档里是普遍成立的，比字号可靠。
 */
import type { PDFDocumentProxy } from 'pdfjs-dist'

export type TocNode = {
  title: string
  /** 1 起，跟页面上看到的页码一致 */
  page: number
  /** 页内纵坐标，PDF 用户空间（原点在左下角） */
  y: number
  level: number
  children?: TocNode[]
}

/** 版式推目录时，一页里合成的一行 */
type Line = {
  page: number
  y: number
  size: number
  text: string
  /** 落在页面上下那条页眉页脚带里 */
  band: boolean
}

/** 字号抖动（0.30000000000000004 这种）在分组时必须抹平 */
function roundSize(size: number): number {
  return Math.round(size * 4) / 4
}

/* ---------------------------------- 书签 ---------------------------------- */

type OutlineItem = {
  title: string
  dest: string | unknown[] | null
  items?: OutlineItem[]
}

/**
 * 解一条 dest，拿到目标页（1 起）和页内纵坐标。
 *
 * dest 第 2 项是「目标模式」，y 在第几位随模式不同：
 *   XYZ → [ref, {name:'XYZ'}, left, top, zoom]，top 在第 4 位
 *   FitH / FitBH → [ref, {name:'FitH'}, top]，top 在第 3 位
 * 其余模式（Fit / FitR / FitV…）没有明确的纵向目标，按页顶算。
 */
async function resolveDest(
  pdf: PDFDocumentProxy,
  dest: string | unknown[] | null,
): Promise<{ page: number; y: number } | null> {
  let resolved: unknown = dest
  if (typeof resolved === 'string') {
    resolved = await pdf.getDestination(resolved)
  }
  if (!Array.isArray(resolved) || resolved.length === 0) return null

  const ref = resolved[0]
  let pageIndex: number
  if (typeof ref === 'number') {
    pageIndex = ref
  } else if (ref && typeof ref === 'object') {
    try {
      pageIndex = await pdf.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0])
    } catch {
      return null
    }
  } else {
    return null
  }
  if (!Number.isFinite(pageIndex) || pageIndex < 0) return null

  const mode = resolved[1]
  const name =
    mode && typeof mode === 'object'
      ? String((mode as { name?: string }).name ?? '')
      : String(mode ?? '')
  let y = 0
  if (name === 'XYZ') y = Number(resolved[3])
  else if (name === 'FitH' || name === 'FitBH') y = Number(resolved[2])

  return { page: pageIndex + 1, y: Number.isFinite(y) ? y : 0 }
}

export async function outlineToc(pdf: PDFDocumentProxy): Promise<TocNode[]> {
  const raw = (await pdf.getOutline()) as OutlineItem[] | null
  if (!raw || raw.length === 0) return []

  async function walk(items: OutlineItem[], level: number): Promise<TocNode[]> {
    const out: TocNode[] = []
    for (const item of items) {
      const title = String(item.title ?? '')
        .replace(/\s+/g, ' ')
        .trim()
      // 单条书签解不出来（ref 指向坏对象之类）不该拖垮整棵树，跳过这一条继续
      let dest: { page: number; y: number } | null = null
      if (title) {
        try {
          dest = await resolveDest(pdf, item.dest ?? null)
        } catch {
          dest = null
        }
      }
      if (title && dest) {
        const kids = Array.isArray(item.items) ? await walk(item.items, level + 1) : []
        const node: TocNode = { title, page: dest.page, y: dest.y, level }
        if (kids.length > 0) node.children = kids
        out.push(node)
      } else if (Array.isArray(item.items)) {
        // 自己没目标但子节点有：把子节点提上来，别整枝丢掉
        out.push(...(await walk(item.items, level)))
      }
    }
    return out
  }

  return walk(raw, 1)
}

/* -------------------------------- 版式推断 -------------------------------- */

/** 页眉页脚所在的高度带：一页上下各 7% */
const BAND = 0.07
/** 认定「这是页眉页脚带」的页数占比 */
const BAND_PAGE_RATIO = 0.5
/** 标题行字数上限。正文里偶尔也有大字号的行（比如放大强调的一句），靠长度兜住 */
const MAX_TITLE_LEN = 60
/** 比正文大多少才算标题 */
const HEADING_RATIO = 1.15

/** 按编号形态认标题：`1.2.3 xxx` / `第三章 xxx` / `Chapter 4 xxx` / `附录 A` */
const NUMBERED =
  /^(?:第\s*[0-9一二三四五六七八九十百]+\s*[章节篇部]|chapter\s+\d+|part\s+\d+|附录\s*[A-Z0-9]?|\d+(?:\.\d+){0,3}[\s、.．])/i

function numberedLevel(text: string): number {
  const dotted = /^(\d+(?:\.\d+){0,3})/.exec(text)
  if (dotted) return Math.min(dotted[1].split('.').length, 3)
  return 1
}

/** 这一行的基线是不是落在页面上下那条页眉页脚带里 */
function inBand(y: number, pageHeight: number): boolean {
  if (pageHeight <= 0) return false
  return y < pageHeight * BAND || pageHeight - y < pageHeight * BAND
}

/** 按出现次数自高到低取前 3 档字号，再按「出现越少层级越高」排成 level 1..n */
function levelByFrequency(lines: Line[], minCount: number): Map<number, number> {
  const count = new Map<number, number>()
  for (const line of lines) {
    const key = roundSize(line.size)
    count.set(key, (count.get(key) ?? 0) + 1)
  }
  const kept = [...count.entries()]
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
  // 次数从少到多 = 层级从高到低
  kept.sort((a, b) => a[1] - b[1])
  return new Map(kept.map(([size], i) => [size, i + 1]))
}

/** 按 level 折成树。层级不连续时（比如没有一级只有二级）按实际嵌套深度重排 */
function buildTree(flat: TocNode[]): TocNode[] {
  const roots: TocNode[] = []
  const stack: TocNode[] = []
  for (const node of flat) {
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) stack.pop()
    if (stack.length === 0) roots.push(node)
    else {
      const parent = stack[stack.length - 1]
      parent.children = parent.children ?? []
      parent.children.push(node)
    }
    stack.push(node)
  }
  // 深度重排：直接取 PDF 某一段（比如附录）当全文看时，第一层可能就是 level 2
  const renumber = (nodes: TocNode[], level: number) => {
    for (const node of nodes) {
      node.level = level
      if (node.children) renumber(node.children, level + 1)
    }
  }
  renumber(roots, 1)
  return roots
}

/**
 * 按版式推目录。扫全文档的文本层，只留下一行行很短的大字行，
 * 所以 405 页也就几秒，不会把整本书的内容堆在内存里。
 */
export async function inferToc(
  pdf: PDFDocumentProxy,
  onProgress?: (done: number, total: number) => void,
): Promise<TocNode[]> {
  const total = pdf.numPages
  const lines: Line[] = []
  /** 字号 → 该字号占的字符数，用来找正文字号（按字数加权，不是按行数） */
  const bodyHist = new Map<number, number>()
  const bandPages = new Set<number>()

  for (let pno = 1; pno <= total; pno += 1) {
    const page = await pdf.getPage(pno)
    const view = page.view
    const pageHeight = view[3] - view[1]
    const content = await page.getTextContent()

    // pdf.js 给的是一个个 run，同一行可能被切成好几段；先按 y 归并成行
    const items: Array<{ x: number; y: number; size: number; str: string }> = []
    for (const item of content.items) {
      if (!('str' in item)) continue
      const str = item.str
      if (!str || !str.trim()) continue
      const t = item.transform
      const size = Math.hypot(t[2], t[3])
      if (!Number.isFinite(size) || size <= 0) continue
      items.push({ x: t[4], y: t[5], size, str })
    }
    items.sort((a, b) => (Math.abs(a.y - b.y) > 1 ? b.y - a.y : a.x - b.x))

    let cur: { y: number; size: number; parts: string[] } | null = null
    const flush = () => {
      if (!cur) return
      const text = cur.parts.join('').replace(/\s+/g, ' ').trim()
      if (text) {
        // 带里的行逐行标出来。不能只标「这一页有页眉页脚」——几乎每页都有页码，
        // 那样整页的短行都会被当成页眉页脚误杀，标题也跟着没了
        const band = inBand(cur.y, pageHeight)
        const line: Line = { page: pno, y: cur.y, size: cur.size, text, band }
        lines.push(line)
        if (band) bandPages.add(pno)
        else bodyHist.set(roundSize(line.size), (bodyHist.get(roundSize(line.size)) ?? 0) + text.length)
      }
      cur = null
    }
    for (const item of items) {
      // 同一行的判定：基线差不超过字号的 1/4
      if (cur && Math.abs(cur.y - item.y) <= Math.max(1, item.size * 0.25)) {
        cur.parts.push(item.str)
        cur.size = Math.max(cur.size, item.size)
      } else {
        flush()
        cur = { y: item.y, size: item.size, parts: [item.str] }
      }
    }
    flush()

    // 文本层读完就把这页的缓存放掉，405 页不会一直堆在内存里
    page.cleanup()
    if (onProgress && (pno % 10 === 0 || pno === total)) onProgress(pno, total)
  }

  if (bodyHist.size === 0) return []
  let body = 0
  let best = -1
  for (const [size, chars] of bodyHist) {
    if (chars > best) {
      best = chars
      body = size
    }
  }

  // 页码在每一页都不同，按文本去重去不掉，只能按「上下那条带里每页都有短行」判
  const bandActive = total >= 8 && bandPages.size / total > BAND_PAGE_RATIO

  const candidates = lines.filter((line) => {
    if (line.text.length > MAX_TITLE_LEN) return false
    if (line.text.length === 0) return false
    // 纯符号 / 纯页码不是标题
    if (!/[\p{L}\p{N}]/u.test(line.text)) return false
    if (line.size < body * HEADING_RATIO) return false
    return true
  })

  // 带里那种 8pt 的页眉页脚本来就小于正文字号，进不了候选；但有的 PDF 页眉比正文还大，
  // 所以认出来之后还是要把带里那几行摘掉
  const kept = bandActive ? candidates.filter((line) => !line.band) : candidates

  let flat: TocNode[] = []
  const levels = levelByFrequency(kept, total >= 10 ? 2 : 1)
  if (levels.size > 0) {
    flat = kept
      .filter((line) => levels.has(roundSize(line.size)))
      .map((line) => ({
        title: line.text,
        page: line.page,
        y: line.y,
        level: levels.get(roundSize(line.size)) ?? 1,
      }))
  }

  // 字号这条路走不通的（整本书标题跟正文一个字号，只靠加粗区分）就用编号形态兜一下
  if (flat.length < 2) {
    const numbered = lines.filter(
      (line) => line.text.length <= 40 && NUMBERED.test(line.text) && !(bandActive && line.band),
    )
    if (numbered.length >= 2) {
      flat = numbered.map((line) => ({
        title: line.text,
        page: line.page,
        y: line.y,
        level: numberedLevel(line.text),
      }))
    }
  }

  if (flat.length < 2) return []
  flat.sort((a, b) => (a.page !== b.page ? a.page - b.page : b.y - a.y))
  return buildTree(flat)
}
