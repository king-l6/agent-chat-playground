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
    unknownImports: [],
    notes: [],
  }
  const seeds = seedFiles.map((f) => f.split(path.sep).join('/')).filter(Boolean)
  if (seeds.length === 0) return out
  // JSX 是「这是个要跑起来的前端项目」的强信号；纯脚本/文档项目不碰
  if (!seeds.some((f) => /\.(tsx|jsx)$/.test(f))) return out

  const root = inferProductRoot(seeds)
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

  if (exists('package.json')) {
    out.notes.push(`${at('package.json')} 已存在，工程文件不动。`)
    return out
  }

  out.detected = true

  // 先看清产出里已经有什么，再决定补什么——生成的入口必须引用真实存在的文件
  const entry = firstExisting(['src/main.tsx', 'src/main.jsx', 'src/index.tsx', 'src/index.jsx', 'src/main.ts'])
  const app =
    firstExisting(['src/App.tsx', 'src/App.jsx', 'src/App.ts']) ?? firstExisting(['App.tsx', 'App.jsx'])
  const css = firstExisting(['src/index.css', 'index.css'])

  const want = [
    'package.json',
    'index.html',
    'vite.config.ts',
    'tsconfig.json',
    'tsconfig.node.json',
    ...(entry ? [] : ['src/main.tsx']),
    ...(app ? [] : ['src/App.tsx']),
  ]
  out.missingBefore = want.filter((rel) => !exists(rel)).map(at)
  if (!exists('package.json') && out.missingBefore.length === 0) return out

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
    if (exists(rel)) return
    const target = at(rel)
    workspaceWrite(target, content)
    written.push(target)
    onWrite?.(target, content)
  }

  const depsJson: Record<string, string> = { react: DEPS.react, 'react-dom': DEPS['react-dom'] }
  for (const name of deps) depsJson[name] = DEPS[name]
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

  if (!app) {
    out.notes.push('产出里没找到 App 组件，补了一个最小占位，页面内容还得接着改。')
    write(
      'src/App.tsx',
      `export default function App() {
  return <main style={{ fontFamily: 'system-ui', padding: 24 }}>还没写页面内容。</main>
}
`,
    )
  }

  if (!entry) {
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
  } else {
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
