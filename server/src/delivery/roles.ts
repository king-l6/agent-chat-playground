/**
 * 角色工具白名单。产品改不了磁盘；评审/测试调不了 write；测试不能跑任意 shell。
 */
import type { DeliveryRole } from './types.js'
import { GateError } from './types.js'

export const WRITE_ALLOWLIST = ['server/src/eval.ts', 'server/src/eval-cases.ts'] as const

const TOOLS: Record<DeliveryRole, readonly string[]> = {
  pm: ['search_notes', 'load_skill'],
  dev: [
    'load_skill',
    'workspace_list',
    'workspace_read',
    'workspace_write',
    'git_status',
    'git_diff',
  ],
  review: ['load_skill', 'workspace_read', 'git_status', 'git_diff'],
  qa: ['load_skill', 'run_allowed_command'],
}

export function toolsFor(role: DeliveryRole) {
  return TOOLS[role]
}

export function assertRoleTool(role: DeliveryRole, name: string) {
  if (!TOOLS[role].includes(name)) {
    throw new GateError('tool', `${role} 不能调用 ${name}`)
  }
}

export function assertWritablePath(rel: string) {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!WRITE_ALLOWLIST.includes(norm as (typeof WRITE_ALLOWLIST)[number])) {
    throw new GateError('write', `实现只能改白名单：${WRITE_ALLOWLIST.join('、')}，拒绝 ${norm}`)
  }
}
