/**
 * 浏览器里的沙箱：把工作台生成的产物挂进 WebContainer 跑起来。
 *
 * 为什么整块逻辑放这儿而不是组件里：
 * 1. `WebContainer.boot()` 每个 document 只能成功一次，`mount()` 更是一次性的。
 *    instance 必须活在模块作用域，组件只能订阅状态，绝不能自己 boot。
 * 2. `@webcontainer/api` 是动态 import 的，不进主 chunk——不用预览的人不该为它付包体。
 *
 * 生命周期（boot → mount 一次 → 之后只做增量同步）：
 *   首次： boot → mount(整棵树) → npm install → npm run dev → server-ready 拿 URL
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
export type PreviewError = { kind: PreviewErrorKind; message: string; detail?: string }

const DEV_TIMEOUT_MS = 90_000

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
      } satisfies PreviewError
    }
    const wc = await WebContainerCtor.boot({ coep: 'credentialless', forwardPreviewErrors: 'exceptions-only' })
    instance = wc
    return wc
  })()
  try {
    return await booting
  } catch (err) {
    booting = null // 失败不缓存：重试只会同样失败，所以由 UI 决定要不要重来
    throw err
  }
}

/** 首次挂载。`mount()` 只能调一次，之后一律走 syncTree */
export async function mountTree(wc: WebContainer, bundle: ArtifactBundle) {
  await wc.mount(buildTree(bundle))
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
    if (dir) await wc.fs.mkdir(dir, { recursive: true })
    await wc.fs.writeFile(node.path, contentsOf(node))
    changed.push(node.path)
  }
  const removed: string[] = []
  for (const path of prev.keys()) {
    if (next.has(path)) continue
    removed.push(path)
    try {
      await wc.fs.rm(path, { force: true })
    } catch {
      /* 已经不在了 */
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

/** npm 的失败原因只有日志尾部说得清，退出码本身认不出来 */
function explainInstall(raw: number, tail: string) {
  // 沙箱给的退出码是 32 位无符号，-2 会显示成 4294967294，先还原成人能读的值
  const code = raw > 0x7fffffff ? raw - 0x100000000 : raw
  if (/Could not read package\.json|package\.json['\s:]*ENOENT|ENOENT[^\n]*package\.json/i.test(tail)) {
    return {
      message: `npm install 失败：产物里没有 package.json（ENOENT，退出码 ${code}）。`,
      detail:
        '这不是网络问题——npm 在沙箱里找不到 package.json，无从下手。让研发把工程文件补齐（评审里那条「必须改」就是这件事）再回来看。',
    }
  }
  if (/EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET|403 Forbidden|404 Not Found|registry/i.test(tail)) {
    return {
      message: `npm install 失败：取不到 npm registry（退出码 ${code}）。`,
      detail: '沙箱装依赖必须能上外网。公司网 / 代理要放行 registry.npmjs.org；点「重试」可以再来一次。',
    }
  }
  return {
    message: `npm install 退出码 ${code}。`,
    detail: '原因看下面的日志末尾——这里不做猜测。',
  }
}

export async function installDeps(wc: WebContainer, onLog: (chunk: string) => void) {
  let tail = ''
  const proc = await wc.spawn('npm', ['install'])
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
  const proc = await wc.spawn('npm', ['run', 'dev'])
  void pipe(proc, onLog)
  const url = await new Promise<string>((resolve, reject) => {
    const off = wc.on('server-ready', (_port, readyUrl) => {
      clearTimeout(timer)
      off()
      resolve(readyUrl)
    })
    const timer = setTimeout(() => {
      off()
      reject({
        kind: 'start',
        message: `${timeoutMs / 1000} 秒内 dev server 没起来。`,
        detail: '看上面的 install / dev 日志末尾。',
      } satisfies PreviewError)
    }, timeoutMs)
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
