import type { AllowedCommand } from './types.js'
import { GateError } from './types.js'
import { sandboxExec, type SandboxExecOpts } from '../sandbox/exec.js'

const ALLOWED: Record<AllowedCommand, { cmd: string; args: string[] }> = {
  'eval:rag': { cmd: 'npm', args: ['run', 'eval:rag'] },
  tsc: { cmd: 'npx', args: ['tsc', '-b', '--pretty', 'false', '--noEmit'] },
  lint: { cmd: 'npm', args: ['run', 'lint'] },
}

/**
 * 测试环节唯一允许起子进程的地方。
 *
 * 白名单没变，变的是「在哪跑」：交给 sandboxExec，由它决定是宿主机还是容器
 * （PLAYGROUND_SANDBOX）。返回值结构保持不动，上层 runtime 不用改判断。
 * 多回一个 sandbox 字段，是为了让测试报告能如实写出「这条命令是在容器里跑的」
 * ——评审/测试报告里能证明隔离，比在文档里声称有用。
 */
export function runAllowedCommand(
  command: string,
  cwd: string,
  ctx?: SandboxExecOpts['ctx'],
) {
  if (!(command in ALLOWED)) {
    throw new GateError('command', `测试只能跑 eval:rag / tsc / lint，拒绝 ${command}`)
  }
  const spec = ALLOWED[command as AllowedCommand]
  const result = sandboxExec(spec.cmd, spec.args, cwd, { timeoutMs: 180_000, ctx })
  // 容器模式的 stdout/stderr 分开来，拼一起给模型和报告看时保持原样
  const excerpt = `${result.stdout}\n${result.stderr}`.trim().slice(-4000)
  const failedToStart = result.status === null && result.error
  return {
    command,
    exitCode: result.status ?? 1,
    excerpt: excerpt || result.error?.message || '(无输出)',
    sandbox: result.mode,
    ...(failedToStart ? { launchError: true } : {}),
  }
}
