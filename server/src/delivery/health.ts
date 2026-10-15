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
/**
 * 解析本地引用时按顺序试的扩展名。**必须含静态资源**：`import logo from './logo.svg'`
 * 是 React 产物的常见写法，少了资源扩展名就会把好文件报成「引用了不存在的模块」——
 * 一个会误报的检查比没有检查更糟，它会训练人忽略结论。
 */
const TRY_EXT = [
  '.tsx', '.ts', '.jsx', '.js',
  '.json', '.css', '.scss',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.avif',
  '.woff', '.woff2', '.ttf', '.otf',
]

/** Node 内置模块：`import fs from 'fs'` 不该被当成「没声明的第三方包」 */
const BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http',
  'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys',
  'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib',
])

/**
 * `.ts` 里出现 JSX 的判据：闭合标签 `</Foo>` / `</>`，或自闭合标签 `<Foo … />`。
 * 泛型（`<T>`、`<T,>() =>`）不会命中。要求**至少两处**命中才算数——单个命中
 * 多半是正文里恰好出现的尖括号，不够格把一次交付判死。
 */
const JSX_TAG = /<\/[A-Za-z][\w.-]*\s*>|<\/>|<[A-Za-z][\w.-]*(?:\s[^<>]*?)?\/>/g

/**
 * 剥掉字符串、模板串与注释，只留代码骨架。**逐行处理**，行数一一对应，剥完还能报行号。
 *
 * 必须先剥再判 JSX：拼 SVG / HTML 的模板串里 `<circle … />` 遍地都是，直接拿正文匹配
 * 会把「拼 SVG 的服务文件」误报成「.ts 里写 JSX」。一个会误报的检查比没有检查更糟——
 * 它会训练人忽略结论。（实测：修好的 imageGeneratorService.ts 就被误报过。）
 *
 * 为什么按行而不是整体扫：本函数认不出正则字面量，而 `/[&<>"']/g` 里的引号会被当成
 * 字符串开头，一路吞掉后面所有内容、连模板串的反引号一起吃掉，整段就此失同步。
 * 按行处理时这种误判最多污染**它自己那一行**：行内引号没闭合就直接放弃该行剩余部分。
 */
function stripNonCode(src: string) {
  let out = ''
  let inBlockComment = false
  let inTemplate = false
  for (const raw of src.split('\n')) {
    let line = ''
    let i = 0
    while (i < raw.length) {
      if (inBlockComment) {
        const end = raw.indexOf('*/', i)
        if (end === -1) {
          i = raw.length
          break
        }
        inBlockComment = false
        i = end + 2
        continue
      }
      if (inTemplate) {
        const end = raw.indexOf('`', i)
        if (end === -1) {
          i = raw.length
          break
        }
        inTemplate = false
        i = end + 1
        continue
      }
      const c = raw[i]
      const next = raw[i + 1]
      if (c === '/' && next === '/') break
      if (c === '/' && next === '*') {
        inBlockComment = true
        i += 2
        continue
      }
      if (c === '`') {
        inTemplate = true
        i += 1
        continue
      }
      if (c === '"' || c === "'") {
        let j = i + 1
        while (j < raw.length) {
          if (raw[j] === '\\') {
            j += 2
            continue
          }
          if (raw[j] === c) break
          j++
        }
        // 行内没闭合：多半是把正则字面量当成了字符串，这行剩下的部分不要了
        if (j >= raw.length) break
        i = j + 1
        continue
      }
      line += c
      i++
    }
    out += `${line}\n`
  }
  return out
}

/** `import|export … from '…'`，含仅副作用的 `import '…'` */
const IMPORT_RE =
  /(?:^|[\s;{(])(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;{])import\s*['"]([^'"]+)['"]/g

/** `react-dom/client` → `react-dom`；`@scope/pkg/x` → `@scope/pkg` */
function bareName(spec: string) {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** 源码里 import 的裸包名（`node:` 前缀与相对路径不算） */
function bareImports(source: string) {
  const out = new Set<string>()
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2]
    if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue
    out.add(bareName(spec))
  }
  return out
}

/** package.json 里声明过的依赖名（四类都算） */
function declaredNames(pkg: Record<string, unknown>) {
  const names = new Set<string>()
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const block = pkg[field]
    if (block && typeof block === 'object') for (const k of Object.keys(block)) names.add(k)
  }
  return names
}

/** 某个包声明的版本区间（dependencies 优先，其次 devDependencies），没有返回 null */
function pkgVersion(pkg: Record<string, unknown>, name: string) {
  for (const field of ['dependencies', 'devDependencies']) {
    const block = pkg[field]
    if (!block || typeof block !== 'object') continue
    const value = (block as Record<string, unknown>)[name]
    if (typeof value === 'string') return value
  }
  return null
}

/** 版本区间里的主版本：`^17.0.2` → 17。认不出来返回 0，交给调用方跳过判断 */
function majorOf(range: string | null) {
  const m = range?.match(/^[^\d]*(\d+)/)
  return m ? Number(m[1]) : 0
}

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
  // 解析出来的对象要留到后面用（依赖声明、scripts 都要看），所以提到函数作用域
  let pkgJson: Record<string, unknown> | null = null
  if (exists(pkg)) {
    const raw = read(pkg)
    try {
      pkgJson = JSON.parse(raw ?? '') as Record<string, unknown>
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
  /*
   * 上面查的全是「工程文件在不在」。但实测踩到的三个硬伤，文件**全都在**：
   * JSX 写进了 .ts、import 了 package.json 没声明的 react-router-dom、import 了从没
   * 建过的 .css。它们一个都编译不过，却一条都报不出来——于是面板说「能跑」，
   * 打开预览是白的。下面这几条就是补这个洞。
   * 只看这批声明的文件，不扫全仓：老仓库里本来就有的历史问题不该算到这轮头上。
   */
  const sources = files.filter((f) => /\.(ts|tsx|js|jsx)$/.test(f))
  const hasTsx = files.some((f) => /\.tsx$/.test(f))
  // 依赖表算一次就够，下面 scripts / 未声明包两处都要用
  const declared = pkgJson ? declaredNames(pkgJson) : new Set<string>()

  if (pkgJson) {
    const scripts = (pkgJson.scripts ?? {}) as Record<string, unknown>
    // 预览**固定**执行 `pnpm run dev`（见 DeliveryPreview），不认 start。实测踩到：
    // 模型那份 package.json 里只有 start/build/test/eject，于是「有 package.json、
    // 有 start 脚本」，看起来什么都不缺，预览却一进来就失败。
    if (!scripts.dev) {
      problems.push(`${pkg} 里没有 dev 脚本，而预览执行的是 pnpm run dev，起不来。`)
    }
    if (hasTsx) {
      for (const need of ['react', 'react-dom']) {
        if (!declared.has(need)) problems.push(`${pkg} 没声明 ${need}，但有 .tsx 文件：装不上就跑不起来。`)
      }
      // 声明了但主版本不对：入口用 react-dom/client（18+ 的 API）而 react 钉在 17，
      // 装出来就是运行时白屏。这类错类型检查也未必报得出来。
      const reactRange = pkgVersion(pkgJson, 'react')
      if (majorOf(reactRange) && majorOf(reactRange) < 18) {
        const usesClientRoot = sources.some((f) => /from\s*['"]react-dom\/client['"]/.test(read(f) ?? ''))
        if (usesClientRoot) {
          problems.push(
            `${pkg} 把 react 钉在 ${reactRange}，但代码 import 了 react-dom/client（React 18 起才有）：版本对不上。`,
          )
        }
      }
    }
  }

  const undeclared = new Map<string, string>() // 包名 → 第一个引用它的文件
  let localShown = 0
  for (const rel of sources) {
    const src = read(rel)
    if (!src) continue

    // (1) `.ts` 里写 JSX。vite 只对 .tsx 做 JSX 转换；更要命的是省扩展名的引用解析时
    //     .ts 排在 .tsx 前面，同名的那份会把这个文件当成正主。
    if (rel.endsWith('.ts')) {
      const code = stripNonCode(src)
      const hits = [...code.matchAll(JSX_TAG)]
      if (hits.length >= 2) {
        const line = code.slice(0, hits[0].index ?? 0).split('\n').length
        problems.push(
          `${rel} 里有 JSX（第 ${line} 行起共 ${hits.length} 处），扩展名却是 .ts。改成 .tsx。`,
        )
      }
    }

    // (2) import 了 package.json 里没有的包：沙箱里装不到，vite 直接解析失败
    if (pkgJson) {
      for (const name of bareImports(src)) {
        if (declared.has(name) || BUILTINS.has(name)) continue
        if (!undeclared.has(name)) undeclared.set(name, rel)
      }
    }

    // (3) import 了不存在的本地文件——漏建 css 就是这条
    if (localShown < 5) {
      for (const problem of checkLocalImports(rel, root)) {
        problems.push(problem)
        if (++localShown >= 5) break
      }
    }
  }
  for (const [name, where] of undeclared) {
    problems.push(
      `${where} import 了 ${name}，但 ${pkg} 的依赖里没有它：装不上，vite 会报 Failed to resolve import。`,
    )
  }

  // (4) 同一个模块名躺在两种扩展名下（routes.ts 与 routes.tsx 并存）。
  //     解析到哪份只取决于扩展名顺序，跟内容新旧无关——实测就是旧的那份带 JSX 赢了。
  const byStem = new Map<string, string[]>()
  for (const rel of files) {
    if (!/\.(ts|tsx|js|jsx)$/.test(rel) || rel.endsWith('.d.ts')) continue
    const stem = rel.replace(/\.(ts|tsx|js|jsx)$/, '')
    byStem.set(stem, [...(byStem.get(stem) ?? []), rel])
  }
  for (const [stem, list] of byStem) {
    if (list.length < 2) continue
    problems.push(`${stem} 同时存在 ${list.join(' 和 ')}，引用是省扩展名的，删掉多余的那份。`)
  }

  const unique = Array.from(new Set(problems))
  // 一次交付里同类问题可能有几十条，全塞进评审意见会淹掉真正的结论
  const capped =
    unique.length > 10
      ? [...unique.slice(0, 10), `…还有 ${unique.length - 10} 条同类问题。`]
      : unique
  evidence.push(...capped)

  return { ok: missing.length === 0 && unique.length === 0, missing, entry, evidence }
}

/**
 * 解析文件里引用的本地路径，返回对不上的那些（人话描述）。
 *
 * 只报**会让人打不开页面**的引用，不报装饰性的：
 * - `<script src>` 找不到 → 白屏，报；
 * - `<link href>`（favicon / preload / 外链样式）找不到 → 最多少个图标，不报。
 *   实测踩过：本仓库自己的 index.html 引 `/favicon.svg`，文件在 `public/` 下由 vite
 *   挂在根路径上，早期版本不认识 `public/` 就把好文件报成缺件——那条误报会让每次
 *   交付的评审都挂着一条「必须改」，人只能一路带风险放行，检查就此失去意义。
 */
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

  const hits: Array<{ spec: string; bases: string[] }> = []
  const rel = (spec: string) => path.posix.join(path.posix.dirname(entry), stripQuery(spec))
  // 相对模块：静态 import / export … from、副作用 import、以及动态 import('…')
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2]
    if (spec?.startsWith('.')) hits.push({ spec, bases: [rel(spec)] })
  }
  for (const m of source.matchAll(/\bimport\s*\(\s*['"](\.[^'"]+)['"]/g)) {
    hits.push({ spec: m[1], bases: [rel(m[1])] })
  }
  // 只在 .html 里看 script src。散在 .ts 正文里的 `src="…"` 是字符串不是引用，
  // 这条拿到所有文件上跑就是一片误报。
  if (entry.endsWith('.html')) {
    for (const m of source.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"'#?]+)["']/gi)) {
      const spec = m[1]
      if (/^[a-z]+:/i.test(spec) || spec.startsWith('//')) continue
      hits.push({
        spec,
        // 以 `/` 开头的是「工程根相对」：先当普通文件找，再按 vite 的 public/ 约定找
        bases: spec.startsWith('/')
          ? [`${spec.replace(/^\/+/, '')}`, `public/${spec.replace(/^\/+/, '')}`]
          : [path.posix.join(path.posix.dirname(entry), spec)],
      })
    }
  }

  for (const { spec, bases } of hits) {
    if (spec.startsWith('//')) continue
    if (bases.some((b) => resolveLocal(root === '.' ? b : path.posix.join(root, b)))) continue
    out.push(`引用了不存在的模块：${spec}（在 ${entry} 里，按 ${bases[0]} 找不到）。`)
  }
  return out
}

/** `./x.css?inline` / `./y.svg#id` 里的 query 与 hash 不是路径的一部分 */
function stripQuery(spec: string) {
  return spec.replace(/[?#].*$/, '')
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
