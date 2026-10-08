/**
 * 工作区沙箱（服务端）：Agent 工具只认这里的 root。
 * 路径必须是相对路径，realpath 之后仍落在 root 内，防止 ../ 和符号链接逃出。
 *
 * root 是两级的：全局默认（聊天页、about 用）+ 请求上下文临时覆盖（交付页每条需求各绑一个仓库）。
 * 后者走 AsyncLocalStorage，绑在异步执行上下文上，随 await 链传播——
 * 交付回合是 SSE、跨 await 跑几分钟，用「切全局 root 再恢复」会被让出的事件循环捅穿。
 */
import fs from 'node:fs'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { DATA_DIR, REPO_ROOT } from './paths.js'

const MAX_BYTES = 256 * 1024
const FILE = path.join(DATA_DIR, 'workspace.json')

const als = new AsyncLocalStorage<{ root: string }>()
let defaultRoot: string | null = null

/** 当前生效的 root：在 withWorkspaceRoot 作用域内用需求仓库，否则用全局默认 */
function currentRoot(): string | null {
  return als.getStore()?.root ?? defaultRoot
}

function restore() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8')) as { root?: string }
    if (typeof data.root === 'string' && fs.existsSync(data.root) && fs.statSync(data.root).isDirectory()) {
      defaultRoot = fs.realpathSync(data.root)
    }
  } catch {
    /* 还没选过 */
  }
}

restore()

export function getWorkspaceRoot() {
  return currentRoot()
}

/** 在这个仓库的作用域里跑一段逻辑（含其中所有 await）。交付回合最外层包一层。 */
export function withWorkspaceRoot<T>(absRoot: string, fn: () => T): T {
  const real = fs.realpathSync(absRoot)
  if (!fs.statSync(real).isDirectory()) {
    throw new Error('需求绑定的仓库不是目录')
  }
  return als.run({ root: real }, fn)
}

export function suggestedHere() {
  return REPO_ROOT
}

export function setWorkspaceRoot(next: string) {
  const real = fs.realpathSync(next)
  if (!fs.statSync(real).isDirectory()) {
    throw new Error('工作区必须是目录')
  }
  defaultRoot = real
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify({ root: defaultRoot }, null, 2), 'utf8')
  return defaultRoot
}

function isInside(base: string, target: string) {
  const rel = path.relative(base, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 把用户给的相对路径钉死在 root 里；绝对路径直接拒绝 */
export function resolveUnderRoot(relPath: string) {
  const root = currentRoot()
  if (!root) throw new Error('未选择工作区。桌面壳菜单「文件 → 打开工作区」选一个目录。')
  const trimmed = relPath.trim() || '.'
  if (path.isAbsolute(trimmed)) {
    throw new Error('只允许工作区内的相对路径')
  }
  const requested = path.resolve(root, trimmed)
  if (!isInside(root, requested)) throw new Error('路径超出工作区')
  try {
    const real = fs.realpathSync(requested)
    if (!isInside(root, real)) throw new Error('路径超出工作区')
    return real
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw err
    let ancestor = path.dirname(requested)
    while (!fs.existsSync(ancestor) && ancestor !== path.dirname(ancestor)) {
      ancestor = path.dirname(ancestor)
    }
    const realAncestor = fs.realpathSync(ancestor)
    if (!isInside(root, realAncestor)) throw new Error('路径超出工作区')
    return requested
  }
}

function toRel(abs: string, name: string) {
  const rel = path.relative(currentRoot() ?? '', path.join(abs, name))
  return rel.split(path.sep).join('/')
}

export function workspaceList(relPath = '.') {
  const dir = resolveUnderRoot(relPath)
  if (!fs.statSync(dir).isDirectory()) throw new Error('不是目录')
  return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    kind: entry.isDirectory() ? 'dir' : 'file',
    path: toRel(dir, entry.name),
  }))
}

export function workspaceRead(relPath: string) {
  if (!relPath.trim()) throw new Error('缺少 path')
  const file = resolveUnderRoot(relPath)
  const st = fs.statSync(file)
  if (!st.isFile()) throw new Error('不是文件')
  if (st.size > MAX_BYTES) throw new Error(`文件超过 ${MAX_BYTES} 字节，拒绝读取`)
  return fs.readFileSync(file, 'utf8')
}

export function workspaceWrite(relPath: string, content: string) {
  if (!relPath.trim()) throw new Error('缺少 path')
  if (typeof content !== 'string') throw new Error('缺少 content')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_BYTES) throw new Error(`内容超过 ${MAX_BYTES} 字节，拒绝写入`)
  const file = resolveUnderRoot(relPath)
  if (fs.existsSync(file) && !fs.statSync(file).isFile()) {
    throw new Error('目标不是文件')
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
  return { path: relPath.split(path.sep).join('/'), bytes }
}

/** 给模型看的工作区摘要：路径 + 根目录清单 + README 开头。未绑工作区返回 null */
export type WorkspaceDigest = {
  root: string
  name: string
  entries: string[]
  more: number
  readme: { file: string; excerpt: string } | null
}

/** 根目录里这些不给模型看：不是项目信息，还会把清单撑爆（node_modules 一个就上千条） */
export const NOISE = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'out',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.turbo',
  'target',
  '.cache',
  'vendor',
  '.DS_Store',
])
const README_CANDIDATES = [
  'README.md',
  'readme.md',
  'Readme.md',
  'README.MD',
  'README.markdown',
  'README.txt',
  'README',
]
const DIGEST_ENTRIES = 40
const README_EXCERPT = 1200

/**
 * 为什么要有这个：模型在 system prompt 里拿不到工作区，用户问「这个项目是干什么的」
 * 它只能去检索知识库，答不到点上（实测：连了代码库还是答「不敢替你认定是哪个」）。
 *
 * 照 memoryBlockFor 的口径做 fail-open：任何一步读不动就少给一点，
 * 绝不把异常抛进聊天链路——工作区信息是锦上添花，不能因为它挂掉整轮对话。
 */
export function workspaceDigest(): WorkspaceDigest | null {
  const base = currentRoot()
  if (!base) return null
  const digest: WorkspaceDigest = {
    root: base,
    name: path.basename(base) || base,
    entries: [],
    more: 0,
    readme: null,
  }
  try {
    // workspaceList 走的是同一套沙箱校验，这里直接复用，不自己 readdir
    const visible = workspaceList('.').filter((entry) => !NOISE.has(entry.name))
    digest.entries = visible
      .slice(0, DIGEST_ENTRIES)
      .map((entry) => (entry.kind === 'dir' ? `${entry.name}/` : entry.name))
    digest.more = Math.max(0, visible.length - DIGEST_ENTRIES)
  } catch {
    /* 列不出来就只给路径 */
  }
  // README 单独探盘找，不靠 entries：它可能被挤到 40 条之外
  const file = README_CANDIDATES.find((name) => fs.existsSync(path.join(base, name)))
  if (file) {
    try {
      digest.readme = { file, excerpt: workspaceRead(file).slice(0, README_EXCERPT) }
    } catch {
      /* 不是文件 / 太大 / 读不动，都当没有 README */
    }
  }
  return digest
}
