/**
 * 工作区（主进程）：选目录 + 与渲染进程 IPC 用的沙箱。
 * Agent 真正读写走 Express（server/src/workspace.ts）；这里防止预加载被骗去读盘外。
 */
import { BrowserWindow, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const MAX_BYTES = 256 * 1024
let root: string | null = null

export function getWorkspaceRoot() {
  return root
}

export function setWorkspaceRoot(next: string) {
  const real = fs.realpathSync(next)
  if (!fs.statSync(real).isDirectory()) {
    throw new Error('工作区必须是目录')
  }
  root = real
  return root
}

function isInside(base: string, target: string) {
  const rel = path.relative(base, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function resolveUnderRoot(relPath: string) {
  if (!root) throw new Error('未选择工作区')
  const trimmed = relPath.trim() || '.'
  if (path.isAbsolute(trimmed)) throw new Error('只允许工作区内的相对路径')
  const requested = path.resolve(root, trimmed)
  try {
    const real = fs.realpathSync(requested)
    if (!isInside(root, real)) throw new Error('路径超出工作区')
    return real
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw err
    const parent = fs.realpathSync(path.dirname(requested))
    if (!isInside(root, parent)) throw new Error('路径超出工作区')
    return path.join(parent, path.basename(requested))
  }
}

export async function pickWorkspace(win?: BrowserWindow | null) {
  const opts = {
    title: '选择工作区',
    properties: ['openDirectory' as const],
  }
  const result = win
    ? await dialog.showOpenDialog(win, opts)
    : await dialog.showOpenDialog(opts)
  if (result.canceled || !result.filePaths[0]) return null
  return setWorkspaceRoot(result.filePaths[0])
}

export async function notifyServer(rootPath: string) {
  const res = await fetch('http://127.0.0.1:8790/api/workspace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: rootPath }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `设置工作区失败 (${res.status})`)
  }
}

export function workspaceList(relPath = '.') {
  const dir = resolveUnderRoot(relPath)
  if (!fs.statSync(dir).isDirectory()) throw new Error('不是目录')
  return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    kind: entry.isDirectory() ? 'dir' : 'file',
    path: path.relative(root ?? '', path.join(dir, entry.name)).split(path.sep).join('/'),
  }))
}

export function workspaceRead(relPath: string) {
  const file = resolveUnderRoot(relPath)
  const st = fs.statSync(file)
  if (!st.isFile()) throw new Error('不是文件')
  if (st.size > MAX_BYTES) throw new Error(`文件超过 ${MAX_BYTES} 字节`)
  return fs.readFileSync(file, 'utf8')
}

export function workspaceWrite(relPath: string, content: string) {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_BYTES) throw new Error(`内容超过 ${MAX_BYTES} 字节`)
  const file = resolveUnderRoot(relPath)
  if (fs.existsSync(file) && !fs.statSync(file).isFile()) {
    throw new Error('目标不是文件')
  }
  fs.writeFileSync(file, content, 'utf8')
  return { path: relPath, bytes }
}
