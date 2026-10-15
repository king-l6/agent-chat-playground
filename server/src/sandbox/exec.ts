/**
 * 执行边界：把一条命令送到该去的地方。
 *
 * 刻意保持和 spawnSync 同形的**同步**签名 —— delivery/commands.ts 是同步的，
 * 这样接上去上层零改动（白名单、返回值结构、GateError 全不用动）。
 *
 * 两种模式的语义差别要说清：
 *   off    = 行为和改造前一模一样，在宿主机 cwd 下跑
 *   docker = 跑在一次性容器里；**docker 不可用时直接失败，绝不回落宿主**。
 *            回落等于沙箱静默失效：日志里一切正常，实际上代码在宿主机上裸跑。
 *            宁可报错让人看见。
 */
import { spawnSync } from 'node:child_process'
import { sandboxMode, type SandboxMode } from './config.js'
import { ensureNodeModules, runContainer } from './docker.js'

export type SandboxExecOpts = {
  timeoutMs?: number
  /** 审计用，落到容器 label 和日志里。不传也能跑。 */
  ctx?: { runId?: string; phase?: string; userId?: string }
}

export type SandboxExecResult = {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
  mode: SandboxMode
  tookMs: number
}

/** docker label 值不能含空格/斜杠之类的松散字符，抹一遍省得拼出非法参数。 */
function safeLabel(v: string | undefined): string {
  return (v ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 63) || 'unknown'
}

export function sandboxExec(
  cmd: string,
  args: string[],
  cwd: string,
  opts: SandboxExecOpts = {},
): SandboxExecResult {
  const mode = sandboxMode()
  const timeoutMs = opts.timeoutMs ?? 180_000
  const started = Date.now()

  if (mode === 'off') {
    const r = spawnSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      shell: false,
    })
    return {
      status: r.status,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      error: r.error ?? undefined,
      mode,
      tookMs: Date.now() - started,
    }
  }

  // ---- docker 模式 ----
  // 依赖先就位：容器里的 node_modules 是 Linux 版，和宿主那份不能共用
  const prep = ensureNodeModules(cwd)
  if (!prep.ok) {
    return {
      status: null,
      stdout: '',
      stderr: prep.message,
      error: new Error(prep.message),
      mode,
      tookMs: Date.now() - started,
    }
  }

  const r = runContainer({
    cmd,
    args,
    workspace: cwd,
    network: false, // 执行段断网
    timeoutMs,
    labels: {
      'pg.run': safeLabel(opts.ctx?.runId),
      'pg.phase': safeLabel(opts.ctx?.phase),
      'pg.user': safeLabel(opts.ctx?.userId),
    },
  })

  console.log(
    `[sandbox] run=${opts.ctx?.runId ?? '-'} phase=${opts.ctx?.phase ?? '-'} ` +
      `${cmd} ${args.join(' ')} exit=${r.status ?? 'null'} ms=${r.tookMs}`,
  )

  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    error: r.error,
    mode,
    tookMs: r.tookMs,
  }
}
