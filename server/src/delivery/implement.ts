/**
 * 研发按冻结 PRD 改选中仓库。
 * 网关 tool calling 不稳，由这边自己读文件、套补丁、失败再读再改。
 */
import OpenAI from 'openai'
import { resolveLlmConfig } from '../agent.js'
import { workspaceList, workspaceRead, workspaceWrite } from '../workspace.js'
import { GateError, type Prd, type TalkTurn } from './types.js'

const SKIP_DIR = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'dist-server',
  'release',
  '.cursor',
  '.claude',
])

const DENY =
  /(^|\/)(\.git|node_modules|release|dist|dist-electron|dist-server)(\/|$)|^\.env$|^\.env\.|^server\/data\//

const ANCHORS = ['src/App.tsx', 'server/src/index.ts']
const MAX_TREE = 50
const MAX_READ = 6
const MAX_CHARS = 6_000
const MAX_WRITE = 8
const MAX_ROUNDS = 3

export function assertWritablePath(rel: string) {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!norm || norm.includes('..') || norm.startsWith('/')) {
    throw new GateError('write', `路径不合法：${rel}`)
  }
  if (DENY.test(norm)) {
    throw new GateError('write', `不能写 ${norm}`)
  }
  return norm
}

function walk(rel = '.', depth = 0): string[] {
  if (depth > 4) return []
  let entries
  try {
    entries = workspaceList(rel)
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    if (SKIP_DIR.has(entry.name)) continue
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue
    if (entry.kind === 'dir') out.push(...walk(entry.path, depth + 1))
    else out.push(entry.path)
    if (out.length >= MAX_TREE) break
  }
  return out.slice(0, MAX_TREE)
}

function preferSource(paths: string[]) {
  const rank = (p: string) =>
    /^(src|server\/src|electron)\//.test(p) ? 0 : /\.(ts|tsx|js|jsx)$/.test(p) ? 1 : 2
  return [...paths].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

function exists(path: string) {
  try {
    workspaceRead(path)
    return true
  } catch {
    return false
  }
}

function readBlob(path: string, limit = MAX_CHARS) {
  try {
    const text = workspaceRead(path)
    const content = text.length > limit ? `${text.slice(0, limit)}\n…(已截断)` : text
    return { path, content, missing: false }
  } catch {
    return { path, content: '(文件还不存在，SEARCH 留空，REPLACE 写全文)', missing: true }
  }
}

function normNl(text: string) {
  return text.replace(/\r\n/g, '\n')
}

function looksFullFile(rel: string, body: string) {
  const t = body.trim()
  if (t.length < 20) return false
  if (rel.endsWith('.json')) return t.startsWith('{') || t.startsWith('[')
  if (/^(import |export |const |function |type |interface |class |\/\*|\/\/|<!|#)/.test(t)) return true
  return t.split('\n').length >= 8
}

function flexReplace(current: string, old: string, next: string) {
  const cur = normNl(current)
  const search = normNl(old)
  const replace = normNl(next)
  if (!search.trim()) return replace
  if (cur.includes(search)) return cur.replace(search, replace)
  const trimmed = search.trim()
  if (trimmed && cur.includes(trimmed)) return cur.replace(trimmed, replace)

  const needle = search.split('\n').map((line) => line.trimEnd())
  while (needle[0] === '') needle.shift()
  while (needle.length && needle[needle.length - 1] === '') needle.pop()
  if (!needle.length) return null
  const hay = cur.split('\n')
  for (let i = 0; i <= hay.length - needle.length; i++) {
    const hit = needle.every(
      (line, j) => hay[i + j].trimEnd() === line || hay[i + j].trim() === line.trim(),
    )
    if (!hit) continue
    const out = hay.slice()
    out.splice(i, needle.length, ...replace.split('\n'))
    return out.join('\n')
  }
  return null
}

function applyEdit(rel: string, oldString: string, newString: string) {
  const path = assertWritablePath(rel)
  const next = normNl(newString)
  const old = normNl(oldString)
  if (!old.trim() || !exists(path)) {
    workspaceWrite(path, next)
    return path
  }
  const current = normNl(workspaceRead(path))
  const swapped = flexReplace(current, old, next)
  if (swapped !== null) {
    workspaceWrite(path, swapped)
    return path
  }
  if (looksFullFile(path, next)) {
    workspaceWrite(path, next)
    return path
  }
  throw new Error(`${path} 对不上 SEARCH`)
}

type Hunk = { path: string; old?: string; next?: string; full?: string }

function cleanPath(raw: string) {
  return raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^[`'"]+|[`'"]+$/g, '').trim()
}

function parseHunks(raw: string): Hunk[] {
  const text = normNl(raw)
  const hunks: Hunk[] = []

  const labeled =
    /(?:^|\n)(?:FILE|path|文件|\*\*\*\s*Update File)[ \t]*[：:=]?[ \t]*(\S+)\n<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g
  for (const match of text.matchAll(labeled)) {
    hunks.push({ path: cleanPath(match[1]), old: match[2], next: match[3] })
  }

  if (hunks.length === 0) {
    const bare =
      /(?:^|\n)([^\s`]+\.(?:ts|tsx|js|jsx|css|md|json|html))\n<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g
    for (const match of text.matchAll(bare)) {
      hunks.push({ path: cleanPath(match[1]), old: match[2], next: match[3] })
    }
  }

  const fences = text.matchAll(/```(?:[\w.-]+)?[ \t]+([^\n`]+)\n([\s\S]*?)```/g)
  for (const match of fences) {
    const path = cleanPath(match[1])
    const content = match[2].replace(/\n$/, '')
    if (!path || path.includes(' ') || !content.trim()) continue
    hunks.push({ path, full: content })
  }

  return hunks.slice(0, MAX_WRITE)
}

function applyHunks(hunks: Hunk[]) {
  const written: string[] = []
  const errors: string[] = []
  for (const hunk of hunks) {
    try {
      if (hunk.full !== undefined) {
        const path = assertWritablePath(hunk.path)
        if (!hunk.full.trim()) throw new Error('全文是空的')
        workspaceWrite(path, hunk.full)
        written.push(path)
      } else if (hunk.old !== undefined && hunk.next !== undefined) {
        written.push(applyEdit(hunk.path, hunk.old, hunk.next))
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  return { written: Array.from(new Set(written)), errors }
}

export type DevTrace = {
  start: (id: string, name: string, args: string) => void
  done: (id: string, name: string, result: string) => void
  fail: (id: string, name: string, error: string) => void
  note: (line: string) => void
}

type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string }

async function askStream(messages: ChatMsg[], onDelta: (piece: string) => void) {
  const { apiKey, baseURL, model } = resolveLlmConfig()
  if (!apiKey) {
    throw new GateError('llm', '研发要按文档改代码，需要 LIVE 和 API Key。先去配置页打开。')
  }
  const client = new OpenAI({ apiKey, baseURL })
  try {
    const stream = await client.chat.completions.create({
      model,
      messages,
      stream: true,
    })
    let text = ''
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta as { content?: string | null; reasoning_content?: string }
      const piece = delta?.content || delta?.reasoning_content || ''
      if (!piece) continue
      text += piece
      onDelta(piece)
    }
    return text.trim()
  } catch (err) {
    if (err instanceof GateError) throw err
    const raw = err instanceof Error ? err.message : String(err)
    if (raw === 'Connection error.' || /fetch failed|ENOTFOUND|ECONNREFUSED/i.test(raw)) {
      throw new GateError('llm', `模型网关连不上${baseURL ? `（${baseURL}）` : ''}。配置页看 LIVE / Base URL。`)
    }
    throw new GateError('llm', raw)
  }
}

const PATCH_SYSTEM = `你在已选工作区里按 PRD 把功能做完整。不要调用工具。只输出补丁。
格式（可重复多块）：

FILE 相对路径
<<<<<<< SEARCH
已有文件的原文；新建或整文件覆盖这里留空
=======
替换后的片段，或新文件/覆盖时的全文
>>>>>>> REPLACE

规则：
- 必须做出能用的功能：页面、路由、接口、前端入口都要写。禁止只加菜单/hash 交差。
- 空目录也要从零新建。SEARCH 留空，REPLACE 写全文。
- 没有的文件就新建。缺的目录不用先建，直接写 dir/file.ts。
- SEARCH 从下面原文抄。对不上就 SEARCH 留空、REPLACE 写该文件全文。
- 不要加评测题，不要只改 eval-cases.ts。
- 不要写 .git / .env / node_modules / dist / release。
- 不要解释。`

function mentionedPaths(...chunks: string[]) {
  const found = new Set<string>()
  const re = /(?:^|[\s`'"=])((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|css|json|md|html))/g
  for (const chunk of chunks) {
    for (const match of chunk.matchAll(re)) found.add(match[1])
  }
  return Array.from(found)
}

function prdText(prd: Prd, note: string, talk: TalkTurn[], lastErrors: string[]) {
  const recent = talk
    .slice(-6)
    .map((t) => `${t.role === 'user' ? '研发' : '上一轮'}：${t.content.slice(0, 400)}`)
    .join('\n')
  return `PRD：\n${JSON.stringify({ title: prd.title, body: prd.body, acceptance: prd.acceptance }, null, 2)}\n\n研发这轮说：${note || '按文档把功能做完整'}\n\n${lastErrors.length ? `上一轮失败，必须先修：\n- ${lastErrors.join('\n- ')}\n` : ''}${recent ? `\n最近对话：\n${recent}` : ''}`
}

function pickReads(tree: string[], note: string, lastErrors: string[]) {
  const named = mentionedPaths(note, ...lastErrors)
  return Array.from(
    new Set([
      ...named.filter((p) => exists(p) || p.includes('/')),
      ...ANCHORS.filter(exists),
      ...tree.filter((p) => /\.(tsx|ts|json)$/.test(p)),
    ]),
  ).slice(0, MAX_READ)
}

function applyTraced(hunks: Hunk[], trace: DevTrace | undefined, tag: string) {
  const written: string[] = []
  const errors: string[] = []
  for (const hunk of hunks) {
    const path = hunk.path
    const id = `${tag}-write-${path}`
    trace?.start(id, 'workspace_write', JSON.stringify({ path }))
    const one = applyHunks([hunk])
    if (one.written[0]) {
      written.push(one.written[0])
      trace?.done(id, 'workspace_write', `已写入 ${one.written[0]}`)
    } else {
      const err = one.errors[0] || '没写进去'
      errors.push(err)
      trace?.fail(id, 'workspace_write', err)
    }
  }
  return { written: Array.from(new Set(written)), errors }
}

export async function implementPrd(
  prd: Prd,
  note: string,
  trace?: DevTrace,
  extra?: { talk?: TalkTurn[]; lastErrors?: string[] },
): Promise<{ files: string[]; reply: string; live: boolean; errors: string[] }> {
  const tree = preferSource(walk())
  if (tree.length === 0) {
    trace?.start('empty-repo', 'workspace_list', '{"path":"."}')
    trace?.done('empty-repo', 'workspace_list', '空目录，这一轮从零建文件')
  }

  const unique = pickReads(tree, note, extra?.lastErrors ?? [])
  const blobs = unique.map((path) => {
    const id = `read-${path}`
    trace?.start(id, 'workspace_read', JSON.stringify({ path }))
    const blob = readBlob(path)
    trace?.done(id, 'workspace_read', blob.missing ? '文件还不存在' : `读到 ${blob.content.length} 字`)
    return blob
  })

  const context = `${prdText(prd, note, extra?.talk ?? [], extra?.lastErrors ?? [])}\n\n仓库文件：\n${tree.length ? tree.slice(0, 40).join('\n') : '（空目录，请新建完整可运行文件）'}\n\n当前文件：\n${blobs.length ? blobs.map((b) => `----- ${b.path} -----\n${b.content}`).join('\n\n') : '（还没有可读文件）'}`
  const messages: ChatMsg[] = [
    { role: 'system', content: PATCH_SYSTEM },
    { role: 'user', content: context },
  ]

  const written: string[] = []
  let errors: string[] = []
  let raw = ''

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const llmId = `write_patch_${round}`
    trace?.start(llmId, round === 1 ? 'write_patch' : 'repair', `第${round}轮写补丁`)
    if (round > 1) trace?.note(`\n\n—— 第${round}轮：对失败的再改 ——\n`)
    raw = await askStream(messages, (piece) => trace?.note(piece))
    trace?.done(llmId, round === 1 ? 'write_patch' : 'repair', raw ? `补丁 ${raw.length} 字` : '模型没吐字')
    messages.push({ role: 'assistant', content: raw || '(空)' })

    const hunks = parseHunks(raw)
    if (hunks.length === 0) {
      errors = [
        raw
          ? `模型回了字但没有可用补丁：${raw.slice(0, 160)}`
          : '模型这轮是空的。到配置页确认 LIVE 通，或再说具体一点。',
      ]
    } else {
      const one = applyTraced(hunks, trace, `r${round}`)
      written.push(...one.written)
      errors = one.errors
    }

    if (errors.length === 0) break
    if (round === MAX_ROUNDS) break

    const failed = mentionedPaths(...errors)
    const reread = (failed.length ? failed : unique).slice(0, MAX_READ).map((path) => readBlob(path, 10_000))
    messages.push({
      role: 'user',
      content: `这些没写上。不要解释。只输出失败文件的补丁：SEARCH 留空，REPLACE 写该文件全文。\n- ${errors.join('\n- ')}\n\n文件：\n${reread.map((b) => `----- ${b.path} -----\n${b.content}`).join('\n\n')}`,
    })
  }

  const files = Array.from(new Set(written))
  if (files.length === 0) {
    console.warn('[delivery-dev] 补丁没落盘', { preview: raw.slice(0, 400), errors })
  }
  return {
    live: true,
    files,
    errors,
    reply: errors.length
      ? `${files.length ? `写了 ${files.join('、')}。` : '这轮没写成。'}还没写成：${errors.join('；')}。再说一句要动哪，我会接着改。`
      : `已经写入 ${files.join('、')}。看左边过程和 diff。还要改就直接说；人点「开发完成」才进评审。`,
  }
}
