/**
 * Docker 侧的动作：探活、起一次性容器、准备 node_modules 卷、清孤儿。
 *
 * 全部是同步的（spawnSync），因为调用方 delivery/commands.ts 是同步的、
 * 上层 runTurnBody 也按同步在用它。**同步的代价是阻塞整个事件循环**：
 * 一次 180s 的 eval:rag 会冻住所有用户请求。这是已知缺陷，phase 2 改异步。
 * 也正因为同步，本进程同一时刻最多只有一个容器在跑，所以这里不搞并发信号量
 * ——那会是个装样子的机制。真并发上限要等改异步时才成立。
 */
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../paths.js'
import {
  CONTAINER_WORKDIR,
  nodeModulesKey,
  nodeModulesVolume,
  sandboxImage,
  sandboxLimits,
  sandboxReadOnly,
  sandboxStateDir,
  sandboxUser,
} from './config.js'

export type ContainerSpec = {
  cmd: string
  args: string[]
  workspace: string
  /** true = 允许出网（只在准备依赖时开） */
  network: boolean
  timeoutMs: number
  labels?: Record<string, string>
}

export type ContainerResult = {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
  tookMs: number
}

/** docker CLI 是否可用。探一次就缓存——daemon 中途挂掉的情况交给实际执行时报错。 */
let available: boolean | null = null

export function dockerAvailable(): boolean {
  if (available !== null) return available
  try {
    const r = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      encoding: 'utf8',
      timeout: 8_000,
    })
    available = r.status === 0
    if (!available) {
      console.warn(
        `[sandbox] docker 不可用：${(r.stderr || r.error?.message || '').trim().slice(0, 200)}`,
      )
    }
  } catch (err) {
    available = false
    console.warn('[sandbox] docker 探活失败：', err instanceof Error ? err.message : err)
  }
  return available
}

/** 强制重新探活（配置改了或 daemon 重启后）。 */
export function resetDockerProbe() {
  available = null
}

function parseUser(): { uid: string; gid: string } | null {
  const u = sandboxUser()
  if (!u) return null
  const [uid, gid] = u.split(':')
  return uid && gid ? { uid, gid } : null
}

/** 统一的 docker run 参数拼装，保证安全参数不漏项。 */
function baseArgs(spec: ContainerSpec): string[] {
  const limits = sandboxLimits()
  const args = [
    'run',
    '--rm',
    '--network',
    spec.network ? 'bridge' : 'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    limits.pids,
    '--memory',
    limits.memory,
    '--memory-swap',
    limits.memory,
    '--cpus',
    limits.cpus,
    '--label',
    'pg.managed=1',
  ]
  for (const [k, v] of Object.entries(spec.labels ?? {})) {
    args.push('--label', `${k}=${v}`)
  }
  const user = parseUser()
  if (user) args.push('--user', `${user.uid}:${user.gid}`)

  if (sandboxReadOnly()) {
    args.push('--read-only', '--tmpfs', '/tmp:rw,size=256m')
    // node / npm 会往 HOME 和 cache 写；只读根下必须显式改道到 tmpfs
    args.push('-e', 'HOME=/tmp', '-e', 'npm_config_cache=/tmp/.npm')
  }

  args.push(
    '-v',
    `${spec.workspace}:${CONTAINER_WORKDIR}`,
    '-v',
    `${nodeModulesVolume(spec.workspace)}:${CONTAINER_WORKDIR}/node_modules`,
    '-w',
    CONTAINER_WORKDIR,
  )
  return args
}

/** 起一个一次性容器跑命令。返回结构和 spawnSync 对齐，便于上层不改判断。 */
export function runContainer(spec: ContainerSpec): ContainerResult {
  const started = Date.now()
  if (!dockerAvailable()) {
    return {
      status: null,
      stdout: '',
      stderr: '',
      error: new Error(
        'Docker 不可用（daemon 没起或没装），拒绝在宿主机上执行。' +
          '请启动 Docker，或把 PLAYGROUND_SANDBOX 设成 off 显式放弃隔离。',
      ),
      tookMs: Date.now() - started,
    }
  }
  const args = [...baseArgs(spec), sandboxImage(), spec.cmd, ...spec.args]
  const r = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: spec.timeoutMs,
    // 容器里的 payload 才是不可信的，宿主这边只是转交参数，不经 shell
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ?? undefined,
    tookMs: Date.now() - started,
  }
}

/**
 * 保证卷里有一份按当前 lock 装出来的 Linux node_modules。
 *
 * 两段式：这一段**要网络**（装依赖），执行段才 --network none。
 * 判断依据是宿主侧的一个标记文件，内容 = package-lock.json 的 sha256；
 * 一致就跳过，省掉「每次跑测试都 npm ci 一遍」。
 *
 * 以 root 跑（不传 --user），装完把卷 chown 给目标 uid/gid ——
 * 卷默认是 root 所有，不 chown 的话执行段以目标用户跑就写不进去。
 * npm ci 不会改 package.json / lock，所以 root 写不到宿主工作区里。
 */
export function ensureNodeModules(workspace: string): { ok: boolean; message: string } {
  const lock = path.join(workspace, 'package-lock.json')
  const hasLock = fs.existsSync(lock)

  const dir = sandboxStateDir(DATA_DIR)
  const marker = path.join(dir, `${nodeModulesKey(workspace)}.lock-sha`)
  const want = hasLock
    ? crypto.createHash('sha256').update(fs.readFileSync(lock)).digest('hex')
    : 'no-lock'

  try {
    if (fs.readFileSync(marker, 'utf8').trim() === want) {
      return { ok: true, message: 'node_modules 已就绪（lock 未变）' }
    }
  } catch {
    /* 没有标记 = 没装过 */
  }

  if (!dockerAvailable()) {
    return { ok: false, message: 'Docker 不可用，无法准备 node_modules' }
  }

  const install = hasLock
    ? 'npm ci --no-audit --no-fund'
    : 'npm install --no-audit --no-fund'
  const user = parseUser()
  const chown = user ? ` && chown -R ${user.uid}:${user.gid} node_modules` : ''
  const script = `mkdir -p node_modules && ${install}${chown}`

  console.log(`[sandbox] 准备 node_modules（要网络）：${workspace}`)
  const r = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'bridge',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      sandboxLimits().pids,
      '--memory',
      '4g',
      '-e',
      'HOME=/tmp',
      '-e',
      'npm_config_cache=/tmp/.npm',
      '-e',
      `npm_config_registry=${process.env.NPM_REGISTRY?.trim() || 'https://registry.npmjs.org/'}`,
      '--label',
      'pg.managed=1',
      '--label',
      'pg.phase=prepare',
      '-v',
      `${workspace}:${CONTAINER_WORKDIR}`,
      '-v',
      `${nodeModulesVolume(workspace)}:${CONTAINER_WORKDIR}/node_modules`,
      '-w',
      CONTAINER_WORKDIR,
      sandboxImage(),
      'sh',
      '-lc',
      script,
    ],
    { encoding: 'utf8', timeout: 15 * 60_000, shell: false, maxBuffer: 16 * 1024 * 1024 },
  )

  if (r.status !== 0) {
    const detail = `${r.stdout || ''}\n${r.stderr || ''}`.trim().slice(-1500)
    return {
      ok: false,
      message: `依赖准备失败（exit=${r.status ?? 'null'}，可能需要网络或内网 npm 源）：\n${detail || r.error?.message || '(无输出)'}`,
    }
  }

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(marker, want, 'utf8')
  return { ok: true, message: 'node_modules 已按当前 lock 装好（Linux 版）' }
}

/**
 * 清掉上次崩溃留下的孤儿容器。
 *
 * 正常路径上每个容器都带 --rm，跑完自己消失；只有进程被 kill 才会漏。
 * 启动时扫一遍比维护 run↔容器映射便宜得多。
 */
export function cleanupOrphanContainers(): number {
  if (!dockerAvailable()) return 0
  const list = spawnSync('docker', ['ps', '-aq', '--filter', 'label=pg.managed=1'], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  const ids = (list.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)
  if (!ids.length) return 0
  spawnSync('docker', ['rm', '-f', ...ids], { encoding: 'utf8', timeout: 30_000 })
  console.log(`[sandbox] 清理 ${ids.length} 个上次残留的沙箱容器`)
  return ids.length
}

/** 只读缓存里的探活结果，**不触发探活**。 */
export function dockerProbeState(): boolean | null {
  return available
}

/**
 * 给 /api/health 用。
 * 刻意不探活：探活是 spawnSync('docker info')，daemon 没起时要等满 8s 超时，
 * 而 spawnSync 会把事件循环整个卡住 —— 一个探活接口把所有人的请求冻 8 秒，
 * 不能这么干。这里只报「配了什么」和「上次探到过什么」（null = 还没探过）。
 */
export function sandboxStatus() {
  return {
    dockerAvailable: dockerProbeState(),
    image: sandboxImage(),
    user: sandboxUser() || '(容器默认)',
    readOnly: sandboxReadOnly(),
    limits: sandboxLimits(),
  }
}
