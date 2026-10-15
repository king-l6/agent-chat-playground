/**
 * 浏览器里的沙箱：把工作台生成的产物挂进 WebContainer 跑起来。
 *
 * 为什么整块逻辑放这儿而不是组件里：
 * 1. `WebContainer.boot()` 每个 document 只能成功一次，`mount()` 更是一次性的。
 *    instance 必须活在模块作用域，组件只能订阅状态，绝不能自己 boot。
 * 2. `@webcontainer/api` 是动态 import 的，不进主 chunk——不用预览的人不该为它付包体。
 *
 * 生命周期（boot → mount 一次 → 之后只做增量同步）：
 *   首次： boot → mount(整棵树) → pnpm install → pnpm run dev → server-ready 拿 URL
 *   之后： 只把内容变了的文件写进去；package.json 变才重跑 install；
 *          vite.config / index.html 变才重启 dev server；其余交给 Vite HMR
 */
import type { FileSystemTree, WebContainer, WebContainerProcess } from '@webcontainer/api'
import type { ArtifactBundle } from '../api/delivery'

export type PreviewPhase = 'idle' | 'fetching' | 'booting' | 'installing' | 'starting' | 'running' | 'error'
/** `incomplete` 单列一类：产物自己缺件，跟环境/网络无关，重试也不会变，只能回研发那里补 */
export type PreviewErrorKind =
  | 'isolation'
  | 'network'
  | 'install'
  | 'start'
  | 'fs'
  | 'incomplete'
  | 'unknown'
export type PreviewError = {
  kind: PreviewErrorKind
  message: string
  detail?: string
  /**
   * 怎么才能好。默认 `retry`：实例还活着，再跑一遍就行。
   * `reload` 表示**这个 document 的沙箱已经废了，只能刷新页面**——
   * boot 是靠往页面里插一个跨域 iframe 拉运行时，SDK 内部把它缓存成一次性状态，
   * 失败后不管重试多少次都挂在同一个死 Promise 上。给「重试」按钮是骗人的。
   */
  recover?: 'retry' | 'reload'
}

const DEV_TIMEOUT_MS = 90_000
/**
 * boot 要拉十几 MB 的运行时（首次），本机实测 ~12 秒。
 * 但比「慢」更要命的是**它不会失败**：iframe 起不来时 SDK 既不 reject 也不报错，
 * 界面就永远停在「启动沙箱…」。所以这条超时是给用户一个结论，不是给网络留余量。
 */
const BOOT_TIMEOUT_MS = 45_000
/** mount / 增量同步都是跨 iframe 的 RPC，实例一死就永远不回包，同样得自己兜底 */
const FS_TIMEOUT_MS = 30_000

/** 给那些自己不带超时的 Promise 兜底。onTimeout 抛的是「怎么恢复」说得清的错误 */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => PreviewError): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/** 沙箱没响应了：实例可能已经死了，重试也唤不回来 */
function staledContainer(what: string): PreviewError {
  return {
    kind: 'fs',
    message: `${what}超时（${FS_TIMEOUT_MS / 1000} 秒没回）。`,
    detail: '沙箱实例没响应了。这是跨 iframe 的 RPC，它自己不会超时——刷新页面重来。',
    recover: 'reload',
  }
}

/** 跨源隔离。`file://`（打包后的 Electron）永远拿不到，这是特性检测出来的硬边界 */
export function isIsolated() {
  return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true
}

function base64ToBytes(b64: string) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function contentsOf(node: { binary: boolean; content: string }) {
  return node.binary ? base64ToBytes(node.content) : node.content
}

/** 扁平的 path 列表 → WebContainer 要的嵌套树 */
export function buildTree(bundle: ArtifactBundle): FileSystemTree {
  const tree: FileSystemTree = {}
  for (const node of bundle.files) {
    const parts = node.path.split('/').filter(Boolean)
    if (parts.length === 0) continue
    let dir = tree
    for (const seg of parts.slice(0, -1)) {
      const cur = dir[seg]
      if (!cur || !('directory' in cur)) dir[seg] = { directory: {} }
      dir = (dir[seg] as { directory: FileSystemTree }).directory
    }
    dir[parts[parts.length - 1]] = { file: { contents: contentsOf(node) } }
  }
  return tree
}

/* ---------------------------------------------------------------- *
 * 单例：boot 一次，之后所有回合共用
 * ---------------------------------------------------------------- */

let instance: WebContainer | null = null
let booting: Promise<WebContainer> | null = null

export async function bootContainer(): Promise<WebContainer> {
  if (instance) return instance
  if (booting) return booting
  booting = (async () => {
    if (!isIsolated()) {
      throw {
        kind: 'isolation',
        message: '当前页面没有跨源隔离，沙箱起不来。',
        detail:
          '预览需要 COOP/COEP 响应头。用 `npm run dev` 打开 http://127.0.0.1:5176（打包后的安装包走 file://，拿不到响应头，用不了预览）。',
      } satisfies PreviewError
    }
    let WebContainerCtor
    try {
      // 动态 import：这段代码和它的 worker 一起走，不进主 bundle
      ;({ WebContainer: WebContainerCtor } = await import('@webcontainer/api'))
    } catch (err) {
      throw {
        kind: 'network',
        message: '沙箱运行时没加载下来（@webcontainer/api 取不到）。',
        detail: err instanceof Error ? err.message : String(err),
        recover: 'reload',
      } satisfies PreviewError
    }
    const wc = await withTimeout(
      WebContainerCtor.boot({ coep: 'credentialless', forwardPreviewErrors: 'exceptions-only' }),
      BOOT_TIMEOUT_MS,
      () => ({
        kind: 'network',
        message: `沙箱运行时 ${BOOT_TIMEOUT_MS / 1000} 秒没加载出来。`,
        detail:
          'boot 会在页面里插一个隐藏 iframe，去 StackBlitz 拉十几 MB 的运行时。这一步断了 SDK 只会一直等——不报错、不超时。\n' +
          '按 F12 → Network 过滤 stackblitz，看那条 headless 请求卡在哪。\n' +
          '注意：这个页面的沙箱已经用掉了，重试没用，要刷新页面才能重来。',
        recover: 'reload',
      }),
    )
    instance = wc
    return wc
  })()
  /*
   * 失败也不重置 booting：SDK 里那个 iframe 每个 document 只加载一次，
   * 失败是固化的——再调一次只会挂到同一个死 Promise 上，白等一轮超时。
   * 所以后续调用直接拿到同一个错误，由 UI 告诉用户「刷新页面」。
   */
  void booting.catch(() => undefined) // 没人接的失败别冒成 unhandled rejection
  return booting
}

/** 首次挂载。`mount()` 只能调一次，之后一律走 syncTree */
export async function mountTree(wc: WebContainer, bundle: ArtifactBundle) {
  await withTimeout(wc.mount(buildTree(bundle)), FS_TIMEOUT_MS, () => staledContainer('往沙箱里挂文件'))
}

export type SyncResult = {
  changed: string[]
  removed: string[]
  /** 下一次同步要比对的内容快照 */
  next: Map<string, string>
}

/**
 * 增量同步：只写内容真的变了的文件。
 * 全量重写会把 Vite 的 watcher 全部触发一遍，HMR 反而变成整页重载。
 *
 * 删掉的也要删：上一轮生成的文件这轮不在了，留着会被 Vite 当入口解析。
 */
export async function syncTree(
  wc: WebContainer,
  bundle: ArtifactBundle,
  prev: Map<string, string>,
): Promise<SyncResult> {
  const next = new Map<string, string>()
  const changed: string[] = []
  for (const node of bundle.files) {
    next.set(node.path, node.content)
    if (prev.get(node.path) === node.content) continue
    const dir = node.path.split('/').slice(0, -1).join('/')
    if (dir) await withTimeout(wc.fs.mkdir(dir, { recursive: true }), FS_TIMEOUT_MS, () => staledContainer(`写入 ${dir}`))
    await withTimeout(wc.fs.writeFile(node.path, contentsOf(node)), FS_TIMEOUT_MS, () =>
      staledContainer(`写入 ${node.path}`),
    )
    changed.push(node.path)
  }
  const removed: string[] = []
  for (const path of prev.keys()) {
    if (next.has(path)) continue
    removed.push(path)
    try {
      await withTimeout(wc.fs.rm(path, { force: true }), FS_TIMEOUT_MS, () => staledContainer(`删除 ${path}`))
    } catch (err) {
      // 已经不在了是正常的；「实例没响应」不能当成删过了，得往上报
      if (err && typeof err === 'object' && 'recover' in err) throw err
    }
  }
  return { changed, removed, next }
}

/* ---------------------------------------------------------------- *
 * 跑起来
 * ---------------------------------------------------------------- */

async function pipe(proc: WebContainerProcess, onLog: (chunk: string) => void) {
  // 输出流读到 proc.exit 为止；不 await 它，否则会挡住退出码
  void proc.output.pipeTo(
    new WritableStream({
      write(chunk) {
        onLog(chunk)
      },
    }),
  ).catch(() => undefined)
}

/** 装依赖失败的原因只有日志尾部说得清，退出码本身认不出来 */
function explainInstall(raw: number, tail: string) {
  // 沙箱给的退出码是 32 位无符号，-2 会显示成 4294967294，先还原成人能读的值
  const code = raw > 0x7fffffff ? raw - 0x100000000 : raw
  // pnpm 和 npm 的说法完全不同：pnpm 是 ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND，npm 是 ENOENT
  if (
    /ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND|Could not read package\.json|package\.json['\s:]*ENOENT|ENOENT[^\n]*package\.json/i.test(
      tail,
    )
  ) {
    return {
      message: `pnpm install 失败：产物里没有 package.json（退出码 ${code}）。`,
      detail:
        '这不是网络问题——包管理器在沙箱里找不到 package.json，无从下手。让研发把工程文件补齐（评审里那条「必须改」就是这件事）再回来看。',
    }
  }
  if (
    /EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET|403 Forbidden|404 Not Found|registry|ERR_PNPM_(META_)?FETCH/i.test(
      tail,
    )
  ) {
    return {
      message: `pnpm install 失败：取不到 registry（退出码 ${code}）。`,
      detail: '沙箱装依赖必须能上外网。公司网 / 代理要放行 registry.npmjs.org；点「重试」可以再来一次。',
    }
  }
  return {
    message: `pnpm install 退出码 ${code}。`,
    detail: '原因看下面的日志末尾——这里不做猜测。',
  }
}

export async function installDeps(wc: WebContainer, onLog: (chunk: string) => void) {
  let tail = ''
  /*
   * 用 pnpm 不用 npm。沙箱里 pnpm 是内置的（8.15.6，在 /usr/local/bin），不用先装。
   * 同一个 package.json 实测：npm 装 79 秒，pnpm 装 30 秒——WebContainer 里的 npm
   * 是跑在 WASM 里的 JS 实现，解包那一步特别慢，pnpm 靠硬链接把这块省掉了。
   *
   * `--reporter=append-only`：默认 reporter 用光标回退在原地重画进度条，
   * 那些控制符进了 <pre> 日志面板就是一堆乱码。
   *
   * 代价：pnpm 的 node_modules 是隔离的，不会像 npm 那样把传递依赖提升到顶层。
   * 产物里 import 了某个没写进 package.json 的包时，npm 可能侥幸能跑、pnpm 一定报
   * Cannot find module —— 这是产物自己的问题，早暴露比晚暴露好。
   */
  const proc = await wc.spawn('pnpm', ['install', '--reporter=append-only'])
  // 顺手留一份尾部，失败时靠它认原因（onLog 那边会截断，不能拿来当证据）
  void pipe(proc, (chunk) => {
    tail = `${tail}${chunk}`.slice(-6000)
    onLog(chunk)
  })
  const raw = await proc.exit
  if (raw === 0) return
  const { message, detail } = explainInstall(raw, tail)
  throw { kind: 'install', message, detail } satisfies PreviewError
}

export type DevHandle = { url: string; dispose: () => void }

/**
 * 起 dev server 并等 `server-ready`。
 * 超时归到 `start` 类：Vite 起不来或没绑定对外地址都会走到这儿，
 * 脚手架模板里的 `server: { host: true }` 就是为了后者。
 */
export async function runDev(
  wc: WebContainer,
  onLog: (chunk: string) => void,
  timeoutMs = DEV_TIMEOUT_MS,
): Promise<DevHandle> {
  let tail = ''
  let earlyUrl: string | null = null
  let resolveReady: ((url: string) => void) | null = null
  let live = true

  /*
   * 监听必须先挂上再 spawn。反过来的话有个窗口：vite 若赶在 `await spawn` 返回之前
   * 就 listen 了，那个 server-ready 就丢了 —— 表现是 dev 明明起来了，却一直等到超时。
   */
  const unsub = wc.on('server-ready', (_port, readyUrl) => {
    stop()
    // spawn 还没返回就先 ready 了：先存着，等下面那个 Promise 建好再交出去
    if (resolveReady) resolveReady(readyUrl)
    else earlyUrl = readyUrl
  })
  function stop() {
    if (live) {
      live = false
      unsub()
    }
  }

  // 依赖是 pnpm 装的，dev 脚本也跟着走 pnpm：少一个「两套包管理器混用」的变量
  const proc = await wc.spawn('pnpm', ['run', 'dev'])
  void pipe(proc, (chunk) => {
    tail = `${tail}${chunk}`.slice(-4000)
    onLog(chunk)
  })

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      stop()
      // 把 dev 自己吐的最后几行带上：不然「看日志末尾」这句等于什么都没说
      const last = tail.trim().slice(-1200)
      reject({
        kind: 'start',
        message: `${timeoutMs / 1000} 秒内 dev server 没起来。`,
        detail: last ? `dev 进程最后吐出来的：\n${last}` : '（dev 进程什么都没输出——它可能压根没跑起来。）',
      } satisfies PreviewError)
    }, timeoutMs)
    if (earlyUrl !== null) {
      clearTimeout(timer)
      resolve(earlyUrl)
      return
    }
    resolveReady = (u) => {
      clearTimeout(timer)
      resolve(u)
    }
  })
  return { url, dispose: () => proc.kill() }
}

/** 把任意异常归到一个能对用户解释的类别，别糊成「预览失败」 */
export function classifyBootError(err: unknown): PreviewError {
  if (err && typeof err === 'object' && 'kind' in err && 'message' in err) {
    return err as PreviewError
  }
  const message = err instanceof Error ? err.message : String(err)
  const detail = err instanceof Error && err.stack ? err.stack.split('\n').slice(0, 3).join('\n') : undefined
  if (/Failed to fetch|NetworkError|ERR_|net::|CORS/i.test(message)) {
    return {
      kind: 'network',
      message: '取沙箱资源失败，多半是没有外网（沙箱运行时来自 StackBlitz CDN）。',
      detail: message,
    }
  }
  if (/ENOENT|ENOTDIR|EISDIR|EEXIST|no such file/i.test(message)) {
    return { kind: 'fs', message: '往沙箱里写文件失败。', detail: message }
  }
  return { kind: 'unknown', message: `预览失败：${message}`, detail }
}
