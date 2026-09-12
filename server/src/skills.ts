/**
 * Agent Skill 发现与读取
 *
 * 和 Tool 不是一类东西：
 *   Tool = 函数（算、搜、掷骰），改状态或取数据
 *   Skill = 磁盘上的说明书（SKILL.md），只教模型「何时、按什么步骤用工具」
 *
 * 加载分两级，避免把所有 playbook 塞进 system prompt：
 *   1. listSkills() 的 name + description 始终可见
 *   2. load_skill 才读正文
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const SKILLS_DIR = path.resolve(__dirname, '../skills')

export type SkillMeta = {
  name: string
  description: string
}

export type SkillRecord = SkillMeta & {
  dir: string
  body: string
}

function parseFrontmatter(raw: string): { name: string; description: string; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null
  const yaml = match[1]
  const body = match[2].trim()
  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim()
  const description = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim()
  if (!name || !description) return null
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) return null
  return { name, description, body }
}

function readSkillFile(file: string): SkillRecord | null {
  if (!fs.existsSync(file)) return null
  const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'))
  if (!parsed) return null
  return { ...parsed, dir: path.dirname(file) }
}

/** 扫描 server/skills/<name>/SKILL.md */
export function listSkills(): SkillMeta[] {
  if (!fs.existsSync(SKILLS_DIR)) return []
  const out: SkillMeta[] = []
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const rec = readSkillFile(path.join(SKILLS_DIR, entry.name, 'SKILL.md'))
    if (rec) out.push({ name: rec.name, description: rec.description })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function readSkill(name: string): SkillRecord {
  const wanted = name.trim()
  if (!wanted) throw new Error('缺少 skill name')

  if (!fs.existsSync(SKILLS_DIR)) {
    throw new Error('未安装任何 skill')
  }

  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const rec = readSkillFile(path.join(SKILLS_DIR, entry.name, 'SKILL.md'))
    if (rec?.name === wanted) return rec
  }

  const available = listSkills().map((s) => s.name)
  throw new Error(
    `未安装 skill: ${wanted}。可用：${available.length ? available.join(', ') : '无'}`,
  )
}

/** 写进 system prompt 的目录；模型只靠这段决定要不要 load_skill */
export function skillsCatalogText(): string {
  const skills = listSkills()
  if (skills.length === 0) return '（当前未安装 skill）'
  return skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
}
