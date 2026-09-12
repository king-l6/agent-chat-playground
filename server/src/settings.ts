/**
 * 网页和桌面共用的模型配置。
 * 存在 DATA_DIR/llm.json：打包后是 userData，开发是 server/data。
 * mode=mock 时即使 .env 里有 Key 也不走网关。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths.js'

export type LlmMode = 'mock' | 'live'

export type LlmSettings = {
  mode: LlmMode
  apiKey: string
  baseURL: string
  model: string
}

export type LlmSettingsPublic = {
  mode: LlmMode
  hasKey: boolean
  baseURL: string
  model: string
}

const FILE = path.join(DATA_DIR, 'llm.json')

let cached: LlmSettings | null = null

function envKey() {
  return (
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.ANTHROPIC_API_KEY?.trim() ||
    ''
  )
}

function envBase() {
  const openaiBase = process.env.OPENAI_BASE_URL?.trim()
  const anthropicBase = process.env.ANTHROPIC_BASE_URL?.trim()?.replace(/\/$/, '')
  return openaiBase || (anthropicBase ? `${anthropicBase}/v1` : '')
}

function envModel() {
  return (
    process.env.OPENAI_MODEL?.trim() ||
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL?.trim() ||
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim() ||
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL?.trim() ||
    'deepseek-v4-flash'
  )
}

function inferFromEnv(): LlmSettings {
  const apiKey = envKey()
  return {
    mode: apiKey ? 'live' : 'mock',
    apiKey: '',
    baseURL: '',
    model: '',
  }
}

function readDisk(): LlmSettings | null {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Partial<LlmSettings>
    if (raw.mode !== 'mock' && raw.mode !== 'live') return null
    return {
      mode: raw.mode,
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
      baseURL: typeof raw.baseURL === 'string' ? raw.baseURL : '',
      model: typeof raw.model === 'string' ? raw.model : '',
    }
  } catch {
    return null
  }
}

export function getLlmSettings(): LlmSettings {
  if (!cached) cached = readDisk() ?? inferFromEnv()
  return cached
}

export function publicLlmSettings(s = getLlmSettings()): LlmSettingsPublic {
  return {
    mode: s.mode,
    hasKey: Boolean(s.apiKey.trim() || envKey()),
    baseURL: s.baseURL.trim() || envBase(),
    model: s.model.trim() || envModel(),
  }
}

export function saveLlmSettings(input: {
  mode: LlmMode
  apiKey?: string
  baseURL?: string
  model?: string
}): LlmSettingsPublic {
  const prev = getLlmSettings()
  const next: LlmSettings = {
    mode: input.mode,
    apiKey: input.apiKey?.trim() ? input.apiKey.trim() : prev.apiKey,
    baseURL: input.baseURL !== undefined ? input.baseURL.trim() : prev.baseURL,
    model: input.model !== undefined ? input.model.trim() : prev.model,
  }
  if (next.mode === 'live' && !next.apiKey && !envKey()) {
    throw new Error('LIVE 需要 API Key')
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8')
  cached = next
  return publicLlmSettings(next)
}

export function resolveLlmFromSettings() {
  const s = getLlmSettings()
  const baseURL = s.baseURL.trim() || envBase() || undefined
  const model = s.model.trim() || envModel()
  if (s.mode === 'mock') return { apiKey: '', baseURL, model }
  return { apiKey: s.apiKey.trim() || envKey(), baseURL, model }
}
