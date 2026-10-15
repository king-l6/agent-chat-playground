/**
 * 产出物的工程骨架兜底。
 *
 * `implement.ts` 的 PATCH_SYSTEM 已经要求模型自己产出 package.json / index.html /
 * vite.config.ts / tsconfig.json / 入口。但模型会漏——实测：对着空目录说「搞一个生成
 * 美女图的项目」，交回来 8 个源码文件、一个工程文件都没有，于是没有一条命令能把它启动。
 * 这里是第二道防线：只在「像刚新建的前端项目、却缺工程文件」时补齐，
 * **绝不覆盖任何已存在的东西**，补出来的文件也照常进 diff、照常被评审看见。
 *
 * 两套路径口径别混：
 * - 「工作区相对」= 写盘 / 读盘 / 进 run.patch.files 用的（`at()`）；
 * - 「工程根相对」= 文件**正文里**的 URL 与 include 用的（如 index.html 的 script src）。
 *   预览时产物根会被剥掉当容器根，所以正文里不能带工作区前缀。
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveUnderRoot, workspaceWrite } from '../workspace.js'
import { inferProductRoot } from './artifacts.js'

export type ScaffoldOutcome = {
  /** 判定为「需要跑起来的前端项目」并真的看过一遍 */
  detected: boolean
  /** 本次真正写入的路径（工作区相对） */
  written: string[]
  /** 动手之前缺哪些工程文件（工作区相对） */
  missingBefore: string[]
  /** 本来存在、但内容不合格被模板重写的（工作区相对） */
  corrected: string[]
  /** 代码 import 了、但模板给不出版本的裸包名 */
  unknownImports: string[]
  /** 人话提示，给 UI 与评审看 */
  notes: string[]
}

/**
 * 已知依赖的版本表。刻意取**保守稳定档**，而不是本仓库自己用的版本
 * （本仓库是 React 19 / Vite 8 / TS 6 这类很新的组合，预览沙箱里未必装得顺）。
 */
const DEPS: Record<string, string> = {
  react: '^18.3.1',
  'react-dom': '^18.3.1',
  axios: '^1.7.7',
  clsx: '^2.1.1',
  'lucide-react': '^0.454.0',
  'react-router-dom': '^6.26.2',
  'react-router': '^6.26.2',
}
const DEV_DEPS: Record<string, string> = {
  '@types/react': '^18.3.12',
  '@types/react-dom': '^18.3.1',
  '@vitejs/plugin-react': '^4.3.1',
  typescript: '^5.5.4',
  vite: '^5.4.8',
}

export function ensureProjectScaffold(
  seedFiles: string[],
  onWrite?: (rel: string, content: string) => void,
): ScaffoldOutcome {
  const out: ScaffoldOutcome = {
    detected: false,
    written: [],
    missingBefore: [],
    corrected: [],
    unknownImports: [],
    notes: [],
  }
  const seeds = seedFiles.map((f) => f.split(path.sep).join('/')).filter(Boolean)
  if (seeds.length === 0) return out
  // JSX 是「这是个要跑起来的前端项目」的强信号；纯脚本/文档项目不碰
  if (!seeds.some((f) => /\.(tsx|jsx)$/.test(f))) return out

  /**
   * 工程根不能只按目录名猜。`inferProductRoot` 只看路径：Next 的 `app/page.tsx`
   * 会让它认 `app` 是工程根，于是往别人的 Next 仓库里塞一整套 Vite 工程文件（实测过）。
   * 先往上找**真的有 package.json** 的那一层——找到就说明这是已有工程，按它来。
   */
  const existsAt = (dir: string, rel: string) => {
    try {
      return fs.existsSync(resolveUnderRoot(dir === '.' ? rel : `${dir}/${rel}`))
    } catch {
      return false
    }
  }
  const nearestProjectRoot = (from: string) => {
    let dir = from
    for (;;) {
      if (existsAt(dir, 'package.json')) return dir
      if (dir === '.') return null
      const up = path.posix.dirname(dir)
      dir = up === '' ? '.' : up
    }
  }
  const guessed = inferProductRoot(seeds)
  // 只在这里偏保守。health / artifacts 不改：它们认错根最多是报错一条，这里认错根是**写进别人的仓库**。
  const root = nearestProjectRoot(guessed) ?? guessed
  /** 工作区相对路径 */
  const at = (rel: string) => (root === '.' ? rel : `${root}/${rel}`)
  /** 工程根相对路径（正文里用） */
  const stripRoot = (p: string) => (root === '.' ? p : p.replace(`${root}/`, ''))

  const exists = (rel: string) => {
    try {
      return fs.existsSync(resolveUnderRoot(at(rel)))
    } catch {
      return false
    }
  }
  const firstExisting = (candidates: string[]) => candidates.find((c) => exists(c)) ?? null
  const readText = (rel: string) => {
    try {
      return fs.readFileSync(resolveUnderRoot(at(rel)), 'utf8')
    } catch {
      return null
    }
  }
  const depsField = (p: Record<string, unknown> | null, field: string) => {
    const block = p?.[field]
    return block && typeof block === 'object' ? (block as Record<string, unknown>) : {}
  }

  /*
   * 判「工程文件对不对」，不是「有没有」。
   *
   * 原来这里只看 `exists('package.json')`，在就直接 return。实测踩到：模型自己写了一份
   * package.json（React 17 / vite 2 / 只有 start 脚本、没有 dev），把上一轮刚补好的那套
   * 反向覆盖；而这里因为「文件在」，再也不管——此后每一轮都看起来一切正常，
   * 只有预览是白的。所以模板负责的那几个文件要逐项验，坏了就按模板重写。
   */
  const broken: Record<string, string[]> = {
    'package.json': [],
    'index.html': [],
    'vite.config.ts': [],
    'tsconfig.json': [],
    'tsconfig.node.json': [],
  }

  const pkgRaw = readText('package.json')
  let pkg: Record<string, unknown> | null = null
  if (pkgRaw === null) {
    broken['package.json'].push('缺文件')
  } else {
    try {
      pkg = JSON.parse(pkgRaw) as Record<string, unknown>
    } catch {
      broken['package.json'].push('JSON 解析不了')
    }
  }
  const scripts = (pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}) as Record<
    string,
    unknown
  >
  if (pkgRaw !== null && broken['package.json'].length === 0 && !scripts.dev) {
    broken['package.json'].push('没有 dev 脚本，而预览执行的就是 pnpm run dev')
  }

  // 只校正「全新」或「本来就是 Vite」的工程。往别人的 Next / CRA / 纯 Node 项目里塞
  // 一个 vite.config.ts 是往人家仓库扔垃圾——这条界限必须有。
  const looksVite =
    pkgRaw === null ||
    Boolean(depsField(pkg, 'dependencies').vite || depsField(pkg, 'devDependencies').vite) ||
    /\bvite\b/.test(`${scripts.dev ?? ''} ${scripts.build ?? ''}`)
  if (!looksVite) {
    out.notes.push(`${at('package.json')} 已存在且不是 Vite 工程，工程文件不动。`)
    return out
  }

  out.detected = true

  const htmlRaw = readText('index.html')
  if (htmlRaw === null) broken['index.html'].push('缺文件')
  else if (!/<script/i.test(htmlRaw)) broken['index.html'].push('没有 <script>，页面会一直是白的')

  const hasTsx = seeds.some((f) => /\.tsx$/.test(f))
  const viteRaw = readText('vite.config.ts')
  if (viteRaw === null) broken['vite.config.ts'].push('缺文件')
  else if (hasTsx && !/plugin-react/.test(viteRaw)) {
    broken['vite.config.ts'].push('没有 @vitejs/plugin-react，.tsx 根本编译不过')
  }

  const tsRaw = readText('tsconfig.json')
  if (tsRaw === null) broken['tsconfig.json'].push('缺文件')
  else if (!parsesJson(tsRaw)) broken['tsconfig.json'].push('JSON 解析不了')

  if (readText('tsconfig.node.json') === null) broken['tsconfig.node.json'].push('缺文件')

  // 先看清产出里已经有什么，再决定补什么——生成的入口必须引用真实存在的文件
  const entry = firstExisting(['src/main.tsx', 'src/main.jsx', 'src/index.tsx', 'src/index.jsx', 'src/main.ts'])
  const app =
    firstExisting(['src/App.tsx', 'src/App.jsx', 'src/App.ts']) ?? firstExisting(['App.tsx', 'App.jsx'])
  const css = firstExisting(['src/index.css', 'index.css'])

  const replace = new Set<string>()
  for (const [rel, reasons] of Object.entries(broken)) {
    if (reasons.length === 0) continue
    replace.add(rel)
    const target = at(rel)
    const had = exists(rel)
    if (had) out.corrected.push(target)
    else out.missingBefore.push(target)
    out.notes.push(`${target} ${had ? '不合格' : '缺失'}（${reasons.join('；')}），按模板${had ? '重写' : '补上'}。`)
  }

  // 入口与 App 只在**全新工程**时补。已有工程的结构可能完全不同（页面放在 pages/ 之类），
  // 按模板硬塞一个 src/App.tsx 等于污染别人的仓库。
  const fresh = pkgRaw === null
  if (fresh && !entry) out.missingBefore.push(at('src/main.tsx'))
  if (fresh && !app) out.missingBefore.push(at('src/App.tsx'))
  if (replace.size === 0 && (!fresh || out.missingBefore.length === 0)) return out

  const sources = seeds
    .filter((f) => /\.(tsx|ts|jsx|js)$/.test(f))
    .map((f) => {
      try {
        return fs.readFileSync(resolveUnderRoot(f), 'utf8')
      } catch {
        return ''
      }
    })
  const joined = sources.join('\n')
  const { deps, unknown } = inferDepsFromImports(sources)
  out.unknownImports = unknown

  const written: string[] = []
  const write = (rel: string, content: string) => {
    // 只有上面验出「不合格」的模板文件才允许覆盖已存在的东西，其余一律不碰
    if (exists(rel) && !replace.has(rel)) return
    const target = at(rel)
    workspaceWrite(target, content)
    if (!written.includes(target)) written.push(target)
    onWrite?.(target, content)
  }

  const depsJson: Record<string, string> = { react: DEPS.react, 'react-dom': DEPS['react-dom'] }
  for (const name of deps) depsJson[name] = DEPS[name]
  // 模型自己声明过、模板不认识的包要留着（比如某个 UI 库），否则会把它需要的依赖抹掉。
  // 模板认识的（react / vite / axios…）一律用模板版本——实测模型写过 react 17 配
  // react-dom/client 的 18 API，装出来就是白屏，光看依赖名根本发现不了。
  const modelDeps = {
    ...depsField(pkg, 'dependencies'),
    ...depsField(pkg, 'devDependencies'),
  }
  for (const [dep, range] of Object.entries(modelDeps)) {
    if (dep in DEPS || dep in DEV_DEPS) continue
    if (typeof range === 'string') depsJson[dep] = range
  }
  // 路由库的版本得跟着代码用的 API 走：装错版本是白屏，不是类型报错
  const routerKey = ['react-router-dom', 'react-router'].find((k) => k in depsJson)
  if (routerKey) {
    const v5 = /\b(useHistory|useRouteMatch|Switch)\b/.test(joined)
    depsJson[routerKey] = v5 ? '^5.3.4' : '^6.26.2'
    out.notes.push(`代码用了路由，按检测到的 API 装了 ${routerKey} ${depsJson[routerKey]}。`)
  }

  const name =
    path
      .basename(resolveUnderRoot(root))
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'generated-app'

  write(
    'package.json',
    `${JSON.stringify(
      {
        name,
        private: true,
        version: '0.0.0',
        type: 'module',
        scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
        dependencies: depsJson,
        devDependencies: DEV_DEPS,
      },
      null,
      2,
    )}\n`,
  )

  write(
    'index.html',
    `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/${stripRoot(at(entry ?? 'src/main.tsx'))}"></script>
  </body>
</html>
`,
  )

  write(
    'vite.config.ts',
    `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // host: true 让 dev server 监听所有地址，容器/沙箱里跑预览才出得来
  server: { host: true },
})
`,
  )

  write(
    'tsconfig.json',
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2020',
          lib: ['ES2020', 'DOM', 'DOM.Iterable'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          jsx: 'react-jsx',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          isolatedModules: true,
        },
        include: ['src'],
      },
      null,
      2,
    )}\n`,
  )

  write(
    'tsconfig.node.json',
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2023'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          noEmit: true,
          skipLibCheck: true,
          strict: true,
        },
        include: ['vite.config.ts'],
      },
      null,
      2,
    )}\n`,
  )

  if (fresh && !app) {
    out.notes.push('产出里没找到 App 组件，补了一个最小占位，页面内容还得接着改。')
    write(
      'src/App.tsx',
      `export default function App() {
  return <main style={{ fontFamily: 'system-ui', padding: 24 }}>还没写页面内容。</main>
}
`,
    )
  }

  if (fresh && !entry) {
    // 入口引用谁，以探测结果为准；探测不到就用上面补的占位 App
    const appRef = importPath(at('src/main.tsx'), app ?? at('src/App.tsx'))
    const cssRef = css ? `\nimport '${importPath(at('src/main.tsx'), css)}'` : ''
    if (!css) out.notes.push('产出里没找到全局样式文件，入口没有 import css。')
    write(
      'src/main.tsx',
      `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '${appRef}'${cssRef}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`,
    )
  } else if (entry) {
    out.notes.push(`入口沿用产出里的 ${entry}，没有另写。`)
  }

  out.written = written
  if (written.length > 0) out.notes.push(`补齐了 ${written.length} 个工程文件，项目可以直接启动。`)
  return out
}

/** 裸包名：`react-dom/client` → `react-dom`，`@scope/pkg/x` → `@scope/pkg` */
function bareName(spec: string) {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function parsesJson(text: string) {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** 从源码里抠出所有裸包 import，分「模板有版本的」和「没见过的」 */
export function inferDepsFromImports(sources: string[]) {
  const seen = new Set<string>()
  const re =
    /(?:^|[\s;{(])import[^'"\n]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;{]})import\s*['"]([^'"]+)['"]/g
  for (const src of sources) {
    for (const m of src.matchAll(re)) {
      const spec = m[1] ?? m[2]
      if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue
      seen.add(bareName(spec))
    }
  }
  const deps: string[] = []
  const unknown: string[] = []
  for (const n of seen) (n in DEPS ? deps : unknown).push(n)
  return { deps: deps.sort(), unknown: unknown.sort() }
}

/** 把 fromFile 到 toFile 的引用写成 import 串（去扩展名，保证以 ./ 或 ../ 开头） */
function importPath(fromFile: string, toFile: string) {
  const rel = path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/')
  const noExt = rel.replace(/\.(tsx|ts|jsx|js)$/, '')
  return noExt.startsWith('.') ? noExt : `./${noExt}`
}
