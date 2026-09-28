/**
 * 剧本 → 结构化分镜。有 Key 走模型并容错解析 JSON；没有就按句切开。
 * 字段和清单里那张表一致：镜号 / 景别 / 时长 / 角色 / 台词 / 画面 / 首帧 / 运镜。
 */
import OpenAI from 'openai'
import { resolveLlmConfig } from '../agent.js'
import { bibleCatalog, lockShots, readBible, scriptCast } from './bible.js'
import { SHOT_SIZES, type Shot, type ShotSize } from './types.js'

const STYLE_PREFIX = '漫剧分镜，统一线稿，平涂上色，角色服装发型跨镜头保持不变'

function clampDuration(n: number): number {
  if (!Number.isFinite(n)) return 5
  return Math.min(8, Math.max(3, Math.round(n)))
}

function asSize(raw: unknown, fallback: ShotSize): ShotSize {
  return SHOT_SIZES.includes(raw as ShotSize) ? (raw as ShotSize) : fallback
}

function asText(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

function normalizeShots(raw: unknown[], fallbackScript: string): Shot[] {
  const shots = raw
    .map((item, i) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
      const description = asText(row.description) || asText(row.画面描述) || fallbackScript.slice(0, 80)
      const characters = Array.isArray(row.characters)
        ? row.characters.map((c) => String(c).trim()).filter(Boolean).slice(0, 4)
        : []
      const shotSize = asSize(row.shotSize ?? row.景别, SHOT_SIZES[i % SHOT_SIZES.length])
      return {
        index: i + 1,
        shotSize,
        durationSec: clampDuration(Number(row.durationSec ?? row.时长)),
        characters,
        dialogue: asText(row.dialogue ?? row.台词),
        description,
        firstFramePrompt: asText(row.firstFramePrompt) || `${STYLE_PREFIX}。${shotSize}。${description}`,
        camera: asText(row.camera ?? row.运镜) || '固定',
        placeId: asText(row.placeId),
        outfitIds: Array.isArray(row.outfitIds) ? row.outfitIds.map((id) => String(id).trim()).filter(Boolean).slice(0, 12) : [],
        propChanges: Array.isArray(row.propChanges)
          ? row.propChanges
              .map((change) => {
                const item = change && typeof change === 'object' ? (change as Record<string, unknown>) : {}
                const name = asText(item.name)
                if (!name) return null
                return { name, where: asText(item.where) }
              })
              .filter((item): item is { name: string; where: string } => Boolean(item))
              .slice(0, 8)
          : [],
      }
    })
    .filter((s) => s.description)
    .slice(0, 8)
  return shots.length ? shots : localStoryboard(fallbackScript)
}

function parseShotJson(raw: string, script: string): Shot[] | null {
  const fenced = raw.match(/\[[\s\S]*\]/)
  const text = fenced?.[0] ?? raw
  try {
    const data = JSON.parse(text) as unknown
    if (!Array.isArray(data)) return null
    return normalizeShots(data, script)
  } catch {
    return null
  }
}

/** 没模型时按空行或句号切开，景别轮转，总长压进 30–60 秒。 */
export function localStoryboard(script: string): Shot[] {
  const text = script.trim()
  const blocks = text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const pieces =
    blocks.length >= 2
      ? blocks
      : text
          .split(/(?<=[。！？])/)
          .map((s) => s.trim())
          .filter(Boolean)
  const rows = (pieces.length ? pieces : [text || '空镜']).slice(0, 8)
  const each = clampDuration(Math.round(36 / rows.length))
  return rows.map((line, i) => {
    const shotSize = SHOT_SIZES[i % SHOT_SIZES.length]
    const dialogue = /[「“"]/.test(line) ? line.replace(/^[^「“"]*[「“"]|[」”"]$/g, '') : ''
    return {
      index: i + 1,
      shotSize,
      durationSec: each,
      characters: [],
      dialogue,
      description: line,
      firstFramePrompt: `${STYLE_PREFIX}。${shotSize}。${line}`,
      camera: i % 2 === 0 ? '固定' : '缓推',
    }
  })
}

/** 视频产线的文字模型。比默认的 deepseek-v4-flash 便宜，只用于拆分镜。 */
export const STORYBOARD_MODEL = 'deepseek-v4.1-flash'

function parseDraft(raw: string): { reply: string; script: string } | null {
  const fenced = raw.match(/\{[\s\S]*\}/)
  const text = fenced?.[0] ?? raw
  try {
    const data = JSON.parse(text) as { reply?: unknown; script?: unknown }
    const reply = typeof data.reply === 'string' ? data.reply.trim() : ''
    const script = typeof data.script === 'string' ? data.script.trim() : ''
    if (!reply && !script) return null
    return { reply: reply || '写成一版了，可以插入下面的剧本。', script }
  } catch {
    const plain = raw.replace(/```json|```/g, '').trim()
    if (plain.length < 8) return null
    return { reply: '写成一版了，可以插入下面的剧本。', script: plain }
  }
}

/** 对话写剧本。script 为空表示这轮只是在问，还没到能开拍的正文。 */
export async function draftScript(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  current: string,
): Promise<{ reply: string; script: string; live: boolean }> {
  const last = messages.filter((m) => m.role === 'user').at(-1)?.content.trim() ?? ''
  const { apiKey, baseURL } = resolveLlmConfig()
  if (!apiKey) {
    const script = last.length >= 8 ? last : current
    return {
      live: false,
      script,
      reply: script ? '没接上模型，先把你这句话当成剧本。' : '先说你想拍什么。',
    }
  }
  const cast = scriptCast(readBible())
  const client = new OpenAI({ apiKey, baseURL })
  const res = await client.chat.completions.create({
    model: STORYBOARD_MODEL,
    messages: [
      {
        role: 'system',
        content: `你帮人把想法收成一段能直接开拍的短剧本，大约 4 到 8 句，含对白。
只返回 JSON：{"reply":"跟用户说的短中文","script":"剧本正文"}
改已有剧本时，script 给改完的全文，不要只给差异。
设定里已经有角色和场景时，缺的细节用设定补上，直接写 script，不要追问谁、在哪、跳什么。
只有设定是空的、而且用户完全没说拍什么时，script 才用空字符串，在 reply 里追问。
${cast ? `\n${cast}` : ''}`,
      },
      {
        role: 'user',
        content: `当前剧本：\n${current.trim() || '（空）'}`,
      },
      ...messages.slice(-8).map((m) => ({ role: m.role, content: m.content })),
    ],
  })
  const message = res.choices?.[0]?.message as { content?: string | null; reasoning_content?: string } | undefined
  const raw = (message?.content || message?.reasoning_content || '').trim()
  const parsed = parseDraft(raw)
  if (!parsed?.script) {
    return {
      live: false,
      reply: parsed?.reply || '这轮没写成剧本。直接说：小白在卧室跳舞。',
      script: '',
    }
  }
  return { ...parsed, live: true }
}

export async function buildStoryboard(script: string, commit = false): Promise<{ shots: Shot[]; live: boolean }> {
  const { apiKey, baseURL } = resolveLlmConfig()
  const catalog = bibleCatalog(readBible())
  if (!apiKey) return { shots: lockShots(localStoryboard(script), commit), live: false }

  const client = new OpenAI({ apiKey, baseURL })
  const res = await client.chat.completions.create({
    model: STORYBOARD_MODEL,
    messages: [
      {
        role: 'system',
        content: `把剧本拆成 4 到 8 个分镜。只返回 JSON 数组，不要 markdown。
每项字段：shotSize（远景|全景|中景|近景|特写）、durationSec（3到8的整数）、characters（角色名数组，只能用设定里的名字）、outfitIds（这一镜要穿上的全部衣橱编号，同一人的衬衫、袜子、鞋各写一个，不要只留一件）、placeId（场景编号，对不上就空字符串）、dialogue、description、camera、propChanges。
description 只写这一镜的动作，不要重写角色外形、衣服和房间陈设。
propChanges 是这一镜对物件位置的改动，形如 [{"name":"玩偶","where":"床头"}]。where 为空表示拿走。没人动过的物件不要写进来。
不要写 firstFramePrompt。
总时长落在 30 到 60 秒。按原文拆，不要另编情节。
${catalog ? `\n设定：\n${catalog}` : ''}`,
      },
      { role: 'user', content: script },
    ],
  })
  const parsed = parseShotJson(res.choices?.[0]?.message?.content ?? '', script)
  const shots = lockShots(parsed ?? localStoryboard(script), commit)
  return { shots, live: Boolean(parsed) }
}
