/**
 * 企微 wiki 导出目录：给文档页列树、读正文。
 * 默认读 server/data/wiki（拷过来的 md），也可用 PLAYGROUND_WIKI 指到导出目录。
 */
import fs from 'node:fs'
import path from 'node:path'
import { WIKI_DIR } from './paths.js'

export type WikiNode = {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: WikiNode[]
}

const MD_RE = /\.(md|markdown|txt)$/i

export function getWikiRoot(): string {
  return WIKI_DIR
}

function isMd(name: string) {
  return MD_RE.test(name)
}

function displayName(filename: string) {
  return filename.replace(MD_RE, '')
}

function assertInsideRoot(root: string, full: string) {
  const base = path.resolve(root)
  const resolved = path.resolve(full)
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('路径越界')
  }
  return resolved
}

export function resolveWikiPath(rel: string): string {
  const root = getWikiRoot()
  const trimmed = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!trimmed || trimmed.includes('\0')) throw new Error('无效路径')
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.some((p) => p === '..' || p === '.')) throw new Error('路径非法')
  return assertInsideRoot(root, path.join(root, ...parts))
}

function walk(dir: string, rel: string): WikiNode | null {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }

  const children: WikiNode[] = []
  const sorted = entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  for (const entry of sorted) {
    if (entry.name.startsWith('.')) continue
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    const childFull = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const node = walk(childFull, childRel)
      if (node) children.push(node)
    } else if (entry.isFile() && isMd(entry.name)) {
      children.push({
        name: displayName(entry.name),
        path: childRel.replace(/\\/g, '/'),
        type: 'file',
      })
    }
  }

  if (!rel) {
    return { name: '文档', path: '', type: 'dir', children }
  }
  if (children.length === 0) return null
  return {
    name: path.basename(dir),
    path: rel.replace(/\\/g, '/'),
    type: 'dir',
    children,
  }
}

function countFiles(node: WikiNode): number {
  if (node.type === 'file') return 1
  return (node.children ?? []).reduce((n, child) => n + countFiles(child), 0)
}

export function listWikiTree(): { root: string; exists: boolean; count: number; tree: WikiNode[] } {
  const root = getWikiRoot()
  const exists = fs.existsSync(root)
  if (!exists) {
    return { root, exists: false, count: 0, tree: [] }
  }
  const top = walk(root, '')
  const tree = top?.children ?? []
  return { root, exists: true, count: countFiles(top ?? { name: '', path: '', type: 'dir', children: tree }), tree }
}

export function readWikiDoc(rel: string): { path: string; title: string; content: string; bytes: number } {
  const full = resolveWikiPath(rel)
  if (!isMd(full)) throw new Error('仅支持 Markdown / 文本')
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error('文档不存在')
  const content = fs.readFileSync(full, 'utf8')
  const title =
    content.match(/^#\s+(.+)$/m)?.[1]?.trim() || displayName(path.basename(full))
  return {
    path: rel.replace(/\\/g, '/'),
    title,
    content,
    bytes: Buffer.byteLength(content),
  }
}

/** 扁平列出所有 md 相对路径；prefix 为空则整库 */
export function listWikiFiles(prefix = ''): string[] {
  const { tree } = listWikiTree()
  const want = prefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const out: string[] = []
  function visit(nodes: WikiNode[]) {
    for (const node of nodes) {
      if (node.type === 'file') {
        if (!want || node.path === want || node.path.startsWith(want + '/')) {
          out.push(node.path)
        }
      } else if (node.children) {
        visit(node.children)
      }
    }
  }
  visit(tree)
  return out
}
