/**
 * 工作区沙箱（服务端）：Agent 工具只认这里的 root。
 * 路径必须是相对路径，realpath 之后仍落在 root 内，防止 ../ 和符号链接逃出。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA_DIR, REPO_ROOT } from './paths.js'

const MAX_BYTES = 256 * 1024
const FILE = path.join(DATA_DIR, 'workspace.json')

let root: string | null = null

function restore() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8')) as { root?: string }
    if (typeof data.root === 'string' && fs.existsSync(data.root) && fs.statSync(data.root).isDirectory()) {
      root = fs.realpathSync(data.root)
    }
  } catch {
    /* 还没选过 */
  }
}

restore()

export function getWorkspaceRoot() {
  return root
}

export function suggestedHere() {
  return REPO_ROOT
}

/** 选工作区之前用：列出磁盘上的子目录，不限于当前 root。 */
export function browseDisk(abs?: string) {
  const home = os.homedir()
  const requested = (abs || '').trim() || home
  if (!path.isAbsolute(requested)) throw new Error('路径必须是绝对路径')
  const start = fs.realpathSync(requested)
  if (!fs.statSync(start).isDirectory()) throw new Error('不是目录')
  const parent = path.dirname(start)
  const entries: Array<{ name: string; path: string }> = []
  for (const entry of fs.readdirSync(start, { withFileTypes: true })) {
    if (entry.name === '.' || entry.name === '..' || entry.name.startsWith('.')) continue
    const full = path.join(start, entry.name)
    try {
      if (!fs.statSync(full).isDirectory()) continue
    } catch {
      continue
    }
    entries.push({ name: entry.name, path: full })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return {
    cwd: start,
    parent: parent !== start ? parent : null,
    home,
    here: REPO_ROOT,
    entries,
  }
}

export function setWorkspaceRoot(next: string) {
  const real = fs.realpathSync(next)
  if (!fs.statSync(real).isDirectory()) {
    throw new Error('工作区必须是目录')
  }
  root = real
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify({ root }, null, 2), 'utf8')
  return root
}

function isInside(base: string, target: string) {
  const rel = path.relative(base, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 把用户给的相对路径钉死在 root 里；绝对路径直接拒绝 */
export function resolveUnderRoot(relPath: string) {
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
  const rel = path.relative(root ?? '', path.join(abs, name))
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
