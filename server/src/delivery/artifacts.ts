/**
 * 交付产物的取数：把工作区里的东西整理成「能看 / 能跑」的形状。
 *
 * 为什么需要这里：`git diff` 只报告**已跟踪**文件的改动。对着一个空目录新建项目时，
 * 这轮写下的文件全是 untracked，`gitDiff` 一个都报不出来——右侧「文件变更」会空着，
 * 评审也拿不到「工程文件缺哪个」的证据。所以未跟踪文件要自己合成 diff。
 */
import fs from 'node:fs'
import path from 'node:path'
import { gitDiff } from '../git.js'
import { NOISE, resolveUnderRoot, workspaceList, workspaceRead } from '../workspace.js'

/** 这批文件的共同目录。单个文件、或分处根目录与子目录时都返回 '.' */
function commonDirOf(paths: string[]) {
  const dirs = paths.map((p) => {
    const norm = p.split(path.sep).join('/')
    const cut = norm.lastIndexOf('/')
    return cut === -1 ? '' : norm.slice(0, cut)
  })
  if (dirs.length === 0) return '.'
  let common = dirs[0].split('/').filter(Boolean)
  for (const dir of dirs.slice(1)) {
    const segs = dir.split('/').filter(Boolean)
    let i = 0
    while (i < common.length && i < segs.length && common[i] === segs[i]) i += 1
    common = common.slice(0, i)
  }
  return common.length ? common.join('/') : '.'
}

/**
 * 推断「工程根」——package.json / index.html 该放在哪个目录。
 *
 * 不能直接取共同父目录：实测这批产出（src/pages/*.tsx、src/App.tsx、src/routes.ts、
 * src/index.css）的共同父目录是 `src`，但工程根显然是工作区根，`package.json` 得放在
 * 上一层。`src` 是源码目录不是工程根，所以共同父目录一旦落在 src 里就往上退一层。
 */
export function inferProductRoot(paths: string[]) {
  const common = commonDirOf(paths)
  if (common === '.') return '.'
  const segs = common.split('/')
  const srcAt = segs.lastIndexOf('src')
  if (srcAt === -1) return common
  return segs.slice(0, srcAt).join('/') || '.'
}

/** 把未跟踪的新文件渲染成标准 unified diff（全 + 行），与 git 的输出形状对齐 */
export function syntheticNewFileDiff(relPath: string, content: string) {
  const p = relPath.split(path.sep).join('/')
  // 文件末尾那个换行是行终止符、不是新的一行，git 不为它输出 "+" 行
  const hasTrailingNewline = content.endsWith('\n')
  const lines = hasTrailingNewline ? content.slice(0, -1).split('\n') : content.split('\n')
  const head = [
    `diff --git a/${p} b/${p}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${p}`,
    `@@ -0,0 +1,${lines.length} @@`,
  ]
  const body = lines.map((line) => `+${line}`)
  if (!hasTrailingNewline && content.length > 0) body.push('\\ No newline at end of file')
  return [...head, ...body].join('\n')
}

/**
 * 从 `git status --porcelain` 的输出里挑出哪些文件是未跟踪的。
 * 未跟踪的**目录**会整体报成一行 `?? dir/`，所以目录条目按前缀匹配。
 */
export function untrackedAmong(porcelain: string, files: string[]) {
  const exact = new Set<string>()
  const dirs: string[] = []
  for (const raw of porcelain.split('\n')) {
    const line = raw.trimEnd()
    if (!line.startsWith('??')) continue
    let p = line.slice(2).trim()
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).replace(/\\(.)/g, '$1')
    const norm = p.split(path.sep).join('/')
    if (norm.endsWith('/')) dirs.push(norm)
    else exact.add(norm)
  }
  return files.filter((f) => exact.has(f) || dirs.some((dir) => f.startsWith(dir)))
}

/** gitDiff 在「没东西可比」时会返回人话占位串，它不是 diff，不能当 diff 用 */
function isPlaceholder(diff: string) {
  return !diff || diff === '(与 HEAD 无差异)' || diff.startsWith('还没有 HEAD')
}

/**
 * 拼出这批文件的 unified diff。已跟踪的走 git，未跟踪的合成。
 * 必须在 withWorkspaceRoot 作用域内调用（内部要读工作区、跑 git）。
 */
export function diffForFiles(files: string[], porcelain: string) {
  const untracked = new Set(untrackedAmong(porcelain, files))
  return files
    .map((file) => {
      if (untracked.has(file)) {
        try {
          return syntheticNewFileDiff(file, workspaceRead(file))
        } catch {
          return ''
        }
      }
      const diff = gitDiff(file).diff
      return isPlaceholder(diff) ? '' : diff
    })
    .filter(Boolean)
    .join('\n\n')
}

/* ------------------------------------------------------------------ *
 * 给浏览器跑预览用的产物包
 * ------------------------------------------------------------------ */

export type ArtifactNode = { path: string; size: number; binary: boolean; content: string }
export type ArtifactSkip = { path: string; reason: 'over-file-cap' | 'over-total-cap' | 'unreadable' }
export type ArtifactBundle = {
  /** 工程根（工作区相对）。容器里以它为根，所以 node.path 一律不带这个前缀 */
  root: string
  files: ArtifactNode[]
  skipped: ArtifactSkip[]
  truncated: boolean
  warnings: string[]
}

const FILE_CAP = 256 * 1024
const TOTAL_CAP = 4 * 1024 * 1024
const FILE_LIMIT = 400
const SCAN_LIMIT = 5000
const BINARY_SNIFF = 8192

/**
 * 名单之外的还有一类必须挡：**点开头的**。`.env` / `.git` / `.claude` 里是密钥和本机配置，
 * 打包发给浏览器 iframe 就等于把它们交出去，跟 NOISE 是两码事。
 */
function excluded(name: string) {
  return NOISE.has(name) || name.startsWith('.')
}

/**
 * 把工程根下的文件整包读出来，供前端 mount 进 WebContainer。
 *
 * 「挂全部」而不是「只挂 patch.files」：新写的代码会 import 没改过的文件，
 * 只挂改动过的在已有仓库里根本跑不起来。代价是可能撞上限，所以超限一律进
 * skipped 并置 truncated，让面板明说，绝不静默少挂几个文件让预览莫名白屏。
 *
 * 必须在 withWorkspaceRoot 作用域内调用。
 */
export function collectArtifacts(seedFiles: string[]): ArtifactBundle {
  const seeds = seedFiles.map((f) => f.split(path.sep).join('/')).filter(Boolean)
  const root = inferProductRoot(seeds)
  const prefix = root === '.' ? '' : `${root}/`
  const bundle: ArtifactBundle = { root, files: [], skipped: [], truncated: false, warnings: [] }

  let scanned = 0
  let total = 0
  const queue = [root]
  while (queue.length) {
    const dir = queue.shift() as string
    let entries
    try {
      entries = workspaceList(dir)
    } catch {
      continue // 目录不存在或越界，当空处理
    }
    for (const entry of entries) {
      if (excluded(entry.name)) continue
      if (++scanned > SCAN_LIMIT) {
        bundle.truncated = true
        bundle.warnings.push(`产物目录太大，扫到 ${SCAN_LIMIT} 个条目就停了，预览里只是其中一部分。`)
        queue.length = 0
        break
      }
      if (entry.kind === 'dir') {
        queue.push(entry.path)
        continue
      }
      // entry.path 是工作区相对；预览里要以工程根为根，所以显示路径得把前缀剥掉
      const display = prefix && entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path
      const skip = (reason: ArtifactSkip['reason']) => bundle.skipped.push({ path: display, reason })

      if (bundle.files.length >= FILE_LIMIT) {
        skip('over-file-cap')
        bundle.truncated = true
        continue
      }
      let size: number
      try {
        size = fs.statSync(resolveUnderRoot(entry.path)).size
      } catch {
        skip('unreadable')
        continue
      }
      if (size > FILE_CAP) {
        skip('over-file-cap')
        bundle.truncated = true
        continue
      }
      if (total + size > TOTAL_CAP) {
        skip('over-total-cap')
        bundle.truncated = true
        continue
      }
      try {
        const buf = fs.readFileSync(resolveUnderRoot(entry.path))
        total += size
        // NUL 字节是二进制最可靠的信号；workspaceRead 走 utf8，图/字体进去必坏
        const binary = buf.subarray(0, BINARY_SNIFF).includes(0)
        bundle.files.push({
          path: display,
          size,
          binary,
          content: binary ? buf.toString('base64') : buf.toString('utf8'),
        })
      } catch {
        skip('unreadable')
      }
    }
  }

  bundle.files.sort((a, b) => a.path.localeCompare(b.path))
  if (bundle.truncated) {
    bundle.warnings.push(`有 ${bundle.skipped.length} 个文件没进预览（超单文件/总量/数量上限）。`)
  }
  if (bundle.files.length === 0) {
    bundle.warnings.push('工程根下一个能挂的文件都没有，预览起不来。')
  }
  return bundle
}
