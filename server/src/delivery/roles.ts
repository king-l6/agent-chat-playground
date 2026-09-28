/**
 * 角色工具白名单。产品改不了磁盘；评审/测试调不了 write；测试不能跑任意 shell。
 */
import type { DeliveryRole } from './types.js'
import { GateError } from './types.js'
import { assertWritablePath } from './implement.js'

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

export { assertWritablePath }
