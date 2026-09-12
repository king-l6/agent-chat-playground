import { spawnSync } from 'node:child_process'
import type { AllowedCommand } from './types.js'
import { GateError } from './types.js'

const ALLOWED: Record<AllowedCommand, { cmd: string; args: string[] }> = {
  'eval:rag': { cmd: 'npm', args: ['run', 'eval:rag'] },
  tsc: { cmd: 'npx', args: ['tsc', '-b', '--pretty', 'false', '--noEmit'] },
  lint: { cmd: 'npm', args: ['run', 'lint'] },
}

export function runAllowedCommand(command: string, cwd: string) {
  if (!(command in ALLOWED)) {
    throw new GateError('command', `测试只能跑 eval:rag / tsc / lint，拒绝 ${command}`)
  }
  const spec = ALLOWED[command as AllowedCommand]
  const result = spawnSync(spec.cmd, spec.args, {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    shell: false,
  })
  const excerpt = `${result.stdout || ''}\n${result.stderr || ''}`.trim().slice(-800)
  return {
    command,
    exitCode: result.status ?? 1,
    excerpt: excerpt || result.error?.message || '(无输出)',
  }
}
