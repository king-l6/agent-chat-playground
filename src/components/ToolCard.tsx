/**
 * 单张 Tool Calling 卡片：展示工具名、参数、结果/错误
 */
import type { ToolCallView } from '../types'
import './ToolCard.css'

function isSkillTool(name: string) {
  return name === 'load_skill'
}

function skillNameFromArgs(raw: string) {
  try {
    const name = (JSON.parse(raw) as { name?: unknown }).name
    return typeof name === 'string' ? name : ''
  } catch {
    return ''
  }
}

/** 根据 tool.status 换样式：running / done / error */
export function ToolCard({ tool }: { tool: ToolCallView }) {
  const skill = isSkillTool(tool.name)
  const skillName = skill ? skillNameFromArgs(tool.arguments) : ''
  return (
    <div
      className={`tool-card tool-card--${tool.status}${skill ? ' tool-card--skill' : ''}`}
    >
      <div className="tool-card__head">
        <span className="tool-card__name">
          {skill ? `skill${skillName ? `:${skillName}` : ''}` : tool.name}
        </span>
        <span className="tool-card__status">
          {tool.status === 'running' && (skill ? '加载中…' : '调用中…')}
          {tool.status === 'done' && (skill ? '已加载' : '完成')}
          {tool.status === 'error' && '失败'}
        </span>
      </div>

      {/* 模型传给工具的参数 */}
      <pre className="tool-card__block">
        <code>{formatJson(tool.arguments)}</code>
      </pre>

      {/* 有结果才展示 */}
      {tool.result != null && (
        <pre className="tool-card__block tool-card__result">
          <code>{formatJson(tool.result)}</code>
        </pre>
      )}

      {/* 失败原因 */}
      {tool.error && <div className="tool-card__error">{tool.error}</div>}
    </div>
  )
}

/** 能 parse 成 JSON 就美化缩进，否则原样返回字符串 */
function formatJson(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
