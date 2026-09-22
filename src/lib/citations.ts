import type { ToolCallView } from '../types'

/** 一条可引用的检索命中（与后端 search_notes 返回的 hits 对齐） */
export type CitationHit = {
  citation: number
  id: string
  docId?: string
  /** 来源文档可读名（含期次），后端 retrieve 时补上 */
  docName?: string
  /** 来源文档完整路径；内置文档没有 */
  docPath?: string
  title: string
  snippet: string
}

/**
 * 从本条助手消息里的 search_notes 工具结果解析 citation → hit
 * 若同一轮里多次 search_notes，后面的 hits 覆盖相同 citation 编号
 */
export function parseCitationHitsFromTools(
  tools: ToolCallView[],
): Map<number, CitationHit> {
  const map = new Map<number, CitationHit>()

  for (const tool of tools) {
    if (tool.name !== 'search_notes' || tool.status !== 'done' || !tool.result) {
      continue
    }
    try {
      const parsed = JSON.parse(tool.result) as { hits?: CitationHit[] }
      for (const hit of parsed.hits ?? []) {
        if (typeof hit.citation === 'number') {
          map.set(hit.citation, hit)
        }
      }
    } catch {
      // 工具结果不是 JSON 就跳过
    }
  }

  return map
}

/**
 * 把正文里的 [1][2] 转成带唯一锚点的 Markdown 链接
 * 同一回答里多个 [1] 会变成 #citation-1-0、#citation-1-1，避免 openKey 对不上
 */
export function injectCitationAnchors(content: string): string {
  const seen = new Map<number, number>()
  return content.replace(/\[(\d+)\]/g, (_, digits) => {
    const n = Number(digits)
    const idx = seen.get(n) ?? 0
    seen.set(n, idx + 1)
    return `[${n}](#citation-${n}-${idx})`
  })
}

/** 解析 injectCitationAnchors 生成的 href */
export function parseCitationHref(href: string): { n: number; instanceKey: string } | null {
  const withIdx = href.match(/^#citation-(\d+)-(\d+)$/)
  if (withIdx) {
    return {
      n: Number(withIdx[1]),
      instanceKey: `${withIdx[1]}-${withIdx[2]}`,
    }
  }
  const plain = href.match(/^#citation-(\d+)$/)
  if (plain) {
    return { n: Number(plain[1]), instanceKey: `${plain[1]}-0` }
  }
  return null
}
