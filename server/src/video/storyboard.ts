/**
 * 剧本 → 结构化分镜。有 Key 走模型并容错解析 JSON；没有就按句切开。
 * 字段和清单里那张表一致：镜号 / 景别 / 时长 / 角色 / 台词 / 画面 / 首帧 / 运镜。
 */
import OpenAI from 'openai'
import { resolveLlmConfig } from '../agent.js'
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

export async function buildStoryboard(script: string): Promise<{ shots: Shot[]; live: boolean }> {
  const { apiKey, baseURL, model } = resolveLlmConfig()
  if (!apiKey) return { shots: localStoryboard(script), live: false }

  const client = new OpenAI({ apiKey, baseURL })
  const res = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: `把剧本拆成 4 到 8 个分镜。只返回 JSON 数组，不要 markdown。
每项字段：shotSize（远景|全景|中景|近景|特写）、durationSec（3到8的整数）、characters（字符串数组）、dialogue、description、firstFramePrompt、camera。
description 写这一镜画面。firstFramePrompt 用中文，开头固定「${STYLE_PREFIX}」。
总时长落在 30 到 60 秒。按原文拆，不要另编情节。`,
      },
      { role: 'user', content: script },
    ],
  })
  const parsed = parseShotJson(res.choices[0]?.message?.content ?? '', script)
  if (!parsed) return { shots: localStoryboard(script), live: false }
  return { shots: parsed, live: true }
}
