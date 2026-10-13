/**
 * 沙箱配置：全部从环境变量读，一处集中，便于在 compose 里改。
 */
import crypto from 'node:crypto'
import os from 'node:os'

export type SandboxMode = 'off' | 'docker'

/**
 * off   = 照旧在宿主机上 spawn（本地开发、Electron 走这条）
 * docker = 命令跑在一次性容器里
 *
 * 默认 off，是为了不改动任何现有开发习惯；服务器部署时显式设 docker。
 * 注意 docker 模式下**不会**因为 daemon 没起就悄悄回落到宿主 —— 那等于沙箱静默失效，
 * 是最阴的一种失败（见 exec.ts）。
 */
export function sandboxMode(): SandboxMode {
  return process.env.PLAYGROUND_SANDBOX?.trim().toLowerCase() === 'docker' ? 'docker' : 'off'
}

export function sandboxImage(): string {
  return process.env.PLAYGROUND_SANDBOX_IMAGE?.trim() || 'playground-sandbox:latest'
}

/**
 * 容器内进程的 uid:gid。
 *
 * 为什么必须显式给：工作区是 bind mount 进容器的，容器里以 root 写出来的文件
 * 在宿主上就是 root 所有，之后宿主进程再想改就 permission denied。
 * 默认取当前进程的 uid/gid —— 服务器上服务进程的 uid 通常就是仓库属主。
 */
export function sandboxUser(): string {
  const raw = process.env.PLAYGROUND_SANDBOX_UID?.trim()
  if (raw) {
    const gid = process.env.PLAYGROUND_SANDBOX_GID?.trim() || raw
    return `${raw}:${gid}`
  }
  // Windows 上 getuid 不存在；拿不到就不传，让容器用它自己的默认用户
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined
  if (uid === undefined || gid === undefined) return ''
  return `${uid}:${gid}`
}

/**
 * 资源上限。16G 机器上必须给，否则一个失控的 npm 就能把整台机器拖垮。
 * 内存默认 2G：eval:rag 要加载 BGE 模型，给太小会 OOM。
 */
export function sandboxLimits() {
  return {
    memory: process.env.PLAYGROUND_SANDBOX_MEMORY?.trim() || '2g',
    cpus: process.env.PLAYGROUND_SANDBOX_CPUS?.trim() || '2',
    pids: process.env.PLAYGROUND_SANDBOX_PIDS?.trim() || '512',
  }
}

/** 容器内工作区挂载点。相对路径一律以它为准。 */
export const CONTAINER_WORKDIR = '/work'

/**
 * 每个仓库一份 Linux node_modules 卷。
 *
 * 为什么不能直接用宿主那份：宿主 node_modules 里有 darwin-only 的原生绑定
 * （@oxlint/binding-darwin-arm64、@rolldown/binding-darwin-arm64、lightningcss-darwin-arm64、
 * @img/sharp-darwin-arm64、fsevents），挂进 Linux 容器后 npm run lint 直接崩。
 * 所以必须让容器自己装一份。
 */
export function nodeModulesVolume(workspace: string): string {
  const key = crypto.createHash('sha1').update(workspace).digest('hex').slice(0, 12)
  return `pg-nm-${key}`
}

/** 卷名同一把 key，用来在宿主上记「这个卷是按哪份 lock 装的」 */
export function nodeModulesKey(workspace: string): string {
  return crypto.createHash('sha1').update(workspace).digest('hex').slice(0, 12)
}

/**
 * 是否给容器加 --read-only。
 *
 * 默认关。开了会和「往 node_modules 卷里 npm ci」以及 npm 的 cache 写入冲突，
 * 需要 tmpfs + 显式 cache 路径才能共存；配错的表现是 npm 报一堆看不懂的权限错。
 * 想要更强隔离时再显式打开。
 */
export function sandboxReadOnly(): boolean {
  return process.env.PLAYGROUND_SANDBOX_READONLY?.trim() === '1'
}

/** 探活缓存目录：宿主侧，不放容器里，省掉一次容器往返。 */
export function sandboxStateDir(dataDir: string): string {
  return `${dataDir}/sandbox`
}

export function hostName(): string {
  return os.hostname()
}
