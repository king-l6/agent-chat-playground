/**
 * 工作区内只读 git。cwd 钉死为已选 root，参数白名单，不走 shell。
 * 没有 checkout / reset / commit。空目录、还没第一次提交也不要炸。
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

  return {
    cwd: root,
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: (result.stderr ?? '').trim(),
  }
}

function clip(text: string) {
  if (text.length <= MAX_CHARS) return text
  return `${text.slice(0, MAX_CHARS)}\n…(已截断)`
}

function noRepo(detail: string) {
  return /not a git repository|不是 git|Could not access 'HEAD'|unknown revision|bad revision|does not have any commits/i.test(
    detail,
  )
}

function hasHead() {
  const result = runGit(['rev-parse', '--verify', 'HEAD'])
  return result.status === 0
}

export function gitStatus() {
  const result = runGit(['status', '--porcelain=v1', '-b'])
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout.trim()
    if (noRepo(detail)) {
      return {
        cwd: result.cwd,
        status: '这个目录还不是 git 仓库，或还没有第一次提交。文件已经写下了，看过程里的写入即可。',
      }
    }
    throw new Error(detail || `git 退出码 ${result.status}`)
  }
  return { cwd: result.cwd, status: clip(result.stdout) || '(工作区干净)' }
}

export function gitDiff(relPath?: string) {
  const root = getWorkspaceRoot()
  if (!root) {
    throw new Error('未选择工作区。桌面壳里先选仓库，再问当前改动。')
  }
  if (relPath?.trim()) resolveUnderRoot(relPath.trim())

  const args = hasHead()
    ? ['diff', 'HEAD', '--no-color']
    : ['diff', '--no-color']
  if (relPath?.trim()) args.push('--', relPath.trim())

  const result = runGit(args)
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout.trim()
    if (noRepo(detail) || /HEAD/.test(detail)) {
      return {
        cwd: result.cwd,
        path: relPath?.trim() || null,
        diff: '还没有 HEAD（空目录或尚未提交）。这轮写下的文件在过程列表里。',
      }
    }
    throw new Error(detail || `git 退出码 ${result.status}`)
  }

  let stdout = clip(result.stdout)
  if (!stdout && !hasHead()) {
    stdout = '还没有 HEAD。新文件不会出现在 git diff 里，看左边写入记录。'
  }
  return {
    cwd: result.cwd,
    path: relPath?.trim() || null,
    diff: stdout || '(与 HEAD 无差异)',
  }
}
