/**
 * 「这份产物能不能启动」的硬检查。
 *
 * 只做**存在性与解析**，不跑命令：工程文件齐不齐、package.json 能不能解析、
 * 入口 import 的本地相对路径能不能落到真实文件。每条结论都带一条实测证据，
 * 评审意见里原样引用——本仓库的规矩是「结论只能基于本轮真的读到的东西」，
 * 不允许模型自称「已经能跑了」。
 *
 * 必须在 withWorkspaceRoot 作用域内调用（走 resolveUnderRoot 的沙箱校验）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveUnderRoot } from '../workspace.js'
import { inferProductRoot } from './artifacts.js'

export type HealthCheck = {
  ok: boolean
  /** 缺哪些工程文件（工作区相对） */
  missing: string[]
  /** 入口文件（工作区相对），探测不到为 null */
  entry: string | null
  /** 每条结论对应一条实测事实，直接进评审意见 */
  evidence: string[]
}

const ENTRY_CANDIDATES = [
  'src/main.tsx',
  'src/main.jsx',
  'src/index.tsx',
  'src/index.jsx',
  'src/main.ts',
  'index.html',
]
const TRY_EXT = ['.tsx', '.ts', '.jsx', '.js', '.json', '.css', '.scss']

export function checkProjectHealth(declaredFiles: string[]): HealthCheck {
  const evidence: string[] = []
  const missing: string[] = []
  const files = declaredFiles.map((f) => f.split(path.sep).join('/')).filter(Boolean)

  const root = inferProductRoot(files)
  const at = (rel: string) => (root === '.' ? rel : `${root}/${rel}`)
  const exists = (rel: string) => {
    try {
      return fs.existsSync(resolveUnderRoot(rel))
    } catch {
      return false
    }
  }
  const read = (rel: string) => {
    try {
      return fs.readFileSync(resolveUnderRoot(rel), 'utf8')
    } catch {
      return null
    }
  }

  // 不是前端项目就别拿工程文件的标准去要求它（改个 README、加个脚本都算交付）
  const looksFrontend =
    files.some((f) => /\.(tsx|jsx|vue|svelte|html)$/.test(f)) || exists(at('package.json'))
  if (!looksFrontend) {
    return {
      ok: true,
      missing: [],
      entry: null,
      evidence: [
        files.length
          ? `本轮改动 ${files.length} 个文件，不含前端工程入口，跳过工程完整性检查。`
          : '本轮没有记录到文件改动，跳过工程完整性检查。',
      ],
    }
  }

  const pkg = at('package.json')
  if (exists(pkg)) {
    const raw = read(pkg)
    try {
      JSON.parse(raw ?? '')
      evidence.push(`${pkg} 存在且能解析。`)
      // 有依赖声明却没 node_modules 不算问题——预览会在沙箱里自己装
    } catch {
      missing.push(pkg)
      evidence.push(`${pkg} 存在但 JSON 解析失败。`)
    }
  } else {
    missing.push(pkg)
    evidence.push(`缺少 ${pkg}，没有它就没有任何一条命令能启动这个项目。`)
  }

  // 存在的入口候选**全部**要查引用，不能命中第一个就收工：
  // src/main.tsx 与 index.html 会同时存在，而 index.html 的 script src
  // 恰恰是最容易写错、错了就白屏的地方。
  const present = ENTRY_CANDIDATES.map(at).filter((c) => exists(c))
  const entry = present[0] ?? null
  const problems: string[] = []
  if (!entry) {
    missing.push(at('src/main.tsx'))
    problems.push('找不到入口（src/main.tsx / src/index.tsx / index.html 都不存在）。')
  } else {
    evidence.push(`入口 ${entry} 存在。`)
    for (const file of present) {
      for (const problem of checkLocalImports(file, root)) problems.push(problem)
    }
    const html = present.find((c) => c.endsWith('.html'))
    // 只有一个 <script> 都没有才算数：src 写错的情况上面已经报了，不重复
    if (html && !/<script/i.test(read(html) ?? '')) {
      problems.push(`${html} 里没有任何 <script>，页面会一直是白的。`)
    }
  }
  evidence.push(...problems)

  return { ok: missing.length === 0 && problems.length === 0, missing, entry, evidence }
}

/** 解析入口引用的本地路径，返回对不上的那些（人话描述） */
function checkLocalImports(entry: string, root: string) {
  const out: string[] = []
  const source = (() => {
    try {
      return fs.readFileSync(resolveUnderRoot(entry), 'utf8')
    } catch {
      return ''
    }
  })()
  if (!source) return out

  const hits: Array<{ spec: string; base: string }> = []
  // .ts/.tsx 入口：看 import 的本地相对模块（`/` 开头的多半是 alias，不碰）
  const re = /\bfrom\s*['"](\.[^'"]+)['"]|\bimport\s*['"](\.[^'"]+)['"]/g
  for (const m of source.matchAll(re)) {
    const spec = m[1] ?? m[2]
    hits.push({ spec, base: path.posix.join(path.posix.dirname(entry), spec) })
  }
  // .html 入口：看 script src / link href。脚手架生成的 script src 走的就是这条
  for (const m of source.matchAll(/\b(?:src|href)\s*=\s*["']([^"'#?]+)["']/g)) {
    const spec = m[1]
    if (/^[a-z]+:/i.test(spec) || spec.startsWith('//')) continue
    hits.push({
      spec,
      // 以 `/` 开头的是「工程根相对」，得挂在产物根上而不是 html 所在目录
      base: spec.startsWith('/')
        ? spec.replace(/^\/+/, '')
        : path.posix.join(path.posix.dirname(entry), spec),
    })
  }

  for (const { spec, base } of hits) {
    if (spec.startsWith('//')) continue
    if (resolveLocal(root === '.' ? base : path.posix.join(root, base))) continue
    out.push(`入口引用了不存在的模块：${spec}（在 ${entry} 里，按 ${base} 找不到）。`)
  }
  return out
}

function resolveLocal(relPath: string): string | null {
  const candidates = [relPath, ...TRY_EXT.map((ext) => `${relPath}${ext}`)]
  if (!path.posix.extname(relPath)) {
    candidates.push(...TRY_EXT.map((ext) => `${relPath}/index${ext}`))
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(resolveUnderRoot(c)) && fs.statSync(resolveUnderRoot(c)).isFile()) return c
    } catch {
      /* 越界或不存在，都当没命中 */
    }
  }
  return null
}
