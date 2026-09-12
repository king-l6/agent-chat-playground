/**
 * 工作区内只读 git。cwd 钉死为已选 root，参数白名单，不走 shell。
 * 没有 checkout / reset / commit。
 */
import { spawnSync } from 'node:child_process'
import { getWorkspaceRoot, resolveUnderRoot } from './workspace.js'

const MAX_CHARS = 16_000

function runGit(args: string[]) {
  const root = getWorkspaceRoot()
  if (!root) {
    throw new Error('未选择工作区。桌面壳里先选仓库，再问当前改动。')
  }

  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 8000,
    maxBuffer: 200 * 1024,
  })

  if (result.error) {
    const err = result.error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') throw new Error('本机没有 git 命令')
    throw result.error
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(detail || `git 退出码 ${result.status}`)
  }

  let stdout = result.stdout ?? ''
  if (stdout.length > MAX_CHARS) {
    stdout = `${stdout.slice(0, MAX_CHARS)}\n…(已截断)`
  }
  return { cwd: root, stdout }
}

export function gitStatus() {
  const { cwd, stdout } = runGit(['status', '--porcelain=v1', '-b'])
  return { cwd, status: stdout || '(工作区干净)' }
}

export function gitDiff(relPath?: string) {
  const args = ['diff', 'HEAD', '--no-color']
  if (relPath?.trim()) {
    resolveUnderRoot(relPath.trim())
    args.push('--', relPath.trim())
  }
  const { cwd, stdout } = runGit(args)
  return { cwd, path: relPath?.trim() || null, diff: stdout || '(与 HEAD 无差异)' }
}
