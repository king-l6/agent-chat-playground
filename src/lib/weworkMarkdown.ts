/**
 * 企微文档转出来的 md 经常把列表拆成两行、用 ● / a. / i. 当项目符号。
 * 渲染前先收成 CommonMark + GFM 能认的格式。
 */
const FENCE = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g

function mapProse(raw: string, fn: (block: string) => string): string {
  return raw
    .split(FENCE)
    .map((chunk) => (chunk.startsWith('```') || chunk.startsWith('~~~') ? chunk : fn(chunk)))
    .join('')
}

const LIST_MARK = '(?:\\d+\\.|[a-z]\\.|(?:i{1,3}|iv|vi{0,3}|ix|x{1,3})\\.|●|•)'

/** 数字项后面的 a. / i. 转成的 - 缩进成子列表 */
function nestBullets(block: string): string {
  const lines = block.split('\n')
  let underOl = false
  return lines
    .map((line) => {
      if (/^[ \t]*\d+\. /.test(line)) {
        underOl = true
        return line
      }
      if (/^- /.test(line) && underOl) return `   ${line}`
      if (line.trim() === '') return line
      if (!/^[ \t]*- /.test(line)) underOl = false
      return line
    })
    .join('\n')
}

export function normalizeWeworkMarkdown(raw: string): string {
  let text = raw.replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n')

  // 去掉导出器加的「原链接 / 知识库路径」头
  text = text.replace(/^#[^\n]+\n+(?:>[^\n]*\n)+\n*(?:---\s*\n+)?/, '')

  text = mapProse(text, (block) => {
    let out = block
    // `1.\n正文` → `1. 正文`
    out = out.replace(
      new RegExp(
        `^([ \\t]*)(${LIST_MARK})[ \\t]*\\n(?=[ \\t]*(?!#{1,6}[ \\t]|${LIST_MARK}[ \\t]|[-*+][ \\t])\\S)`,
        'gm',
      ),
      '$1$2 ',
    )
    out = out.replace(/^([ \t]*)[●•][ \t]+/gm, '$1- ')
    out = out.replace(/^([ \t]*)[a-z]\.[ \t]+/gm, '$1- ')
    out = out.replace(/^([ \t]*)(?:i{1,3}|iv|vi{0,3}|ix|x{1,3})\.[ \t]+/gim, '$1- ')
    out = out.replace(/^[ \t]+$/gm, '')
    out = out.replace(/^#{1,6}[ \t]*$/gm, '')
    out = out.replace(/^([ \t]*(?:\d+\.|[-*+]) .+\n)\n+(?=[ \t]*(?:\d+\.|[-*+]) )/gm, '$1')
    out = nestBullets(out)
    out = out.replace(/\n{3,}/g, '\n\n')
    return out
  })

  return text.trim()
}
