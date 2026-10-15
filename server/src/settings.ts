/**
 * 网页和桌面共用的模型配置。
 * 存在 DATA_DIR/llm.json：打包后是 userData，开发是 server/data。
 * mode=mock 时即使 .env 里有 Key 也不走网关。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths.js'
import { currentUserId, userConfigFile } from './requestContext.js'
import { userEnvGet } from './userEnv.js'

export type LlmMode = 'mock' | 'live'

export type LlmSettings = {
  mode: LlmMode
  apiKey: string
  baseURL: string
  model: string
  /** 模型上下文窗口（token）。老 llm.json 里没有这个字段，所以是可选的 */
  contextWindow?: number
}

export type LlmSettingsPublic = {
  mode: LlmMode
  hasKey: boolean
  baseURL: string
  model: string
  /** 前端「上下文用量」的分母。来源：llm.json → 环境变量 → 兜底常量 */
  contextWindow: number
}

function llmFile() {
  return userConfigFile('llm.json')
}

/**
 * 兜底窗口大小（token）：llm.json 和环境变量都没给时用。
 *
 * **它不对应任何具体模型，也不是探测来的**：面板的「模型」是自由文本
 * （占位 deepseek-v4-flash），本仓库里没有「模型名 → 官方窗口」的映射表
 * （也不要为了这个去伪造一张表），所以 32k 只是「放得下本项目 system prompt +
 * 几轮对话」的保守缺省值，和默认模型名一样属于占位。
 *
 * 32000 落在「上一代主流」档（8k/16k → **32k/64k** → 128k → 200k → 1M），
 * 而不是当下 API 的常见档：现在公开 API 里 128k / 200k 更常见，长上下文档到 1M。
 * 所以「留空 = 32k」意味着用量环会比其他模型更容易接近满格——这是**没填**的症状，
 * 不是模型只有 32k。要准确值请在「配置」页填，或设环境变量
 * `CONTEXT_WINDOW_TOKENS`（档位说明见 .env.example）。
 *
 * 前端 lib/contextUsage.ts 里有个同名同值的常量，它只在前端拿不到 health 时兜底。
 */
export const DEFAULT_CONTEXT_WINDOW = 32_000

/**
 * 窗口大小的合法区间（token）。两个数是**守卫**，不是能力声明：
 *   - 下界 1_000：再小连 system prompt（规则 1–10 + 工具 schema）都放不下，填了没意义，
 *     基本可以确定是手滑；
 *   - 上界 2_000_000：当前公开的商用模型窗口都到这个量级为止（长上下文档 1M–2M），
 *     超过它基本是多打了一串 0。
 *
 * 之所以只能做区间校验、做不到「填了模型名就自动带出窗口」：模型名在本项目是自由文本，
 * 没有可查的表（也不要为了这个去伪造一张表）。所以要按真实模型改，只改这里的数。
 *
 * 改动时要同步两处对偶：前端 `src/components/SettingsPage.tsx` 里的同值常量（做即时提示），
 * 以及 `.env.example` 里 `CONTEXT_WINDOW_TOKENS` 的注释。
 */
export const MIN_CONTEXT_WINDOW = 1_000
export const MAX_CONTEXT_WINDOW = 2_000_000

const cachedByUser = new Map<string, LlmSettings>()

function envKey() {
  return (
    userEnvGet('OPENAI_API_KEY') ||
    userEnvGet('ANTHROPIC_API_KEY') ||
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.ANTHROPIC_API_KEY?.trim() ||
    ''
  )
}

function envBase() {
  const openaiUser = userEnvGet('OPENAI_BASE_URL')
  if (openaiUser) return openaiUser
  const anthropicUser = userEnvGet('ANTHROPIC_BASE_URL').replace(/\/$/, '')
  if (anthropicUser) return `${anthropicUser}/v1`
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

/**
 * 环境变量里的窗口大小。CONTEXT_WINDOW_TOKENS 优先，
 * 兼容 OPENAI_CONTEXT_WINDOW；解析不出正整数、或落在合法区间外，都返回 0（＝没配置）。
 */
function envContextWindow(): number {
  return normalizeWindow(
    process.env.CONTEXT_WINDOW_TOKENS?.trim() || process.env.OPENAI_CONTEXT_WINDOW?.trim() || '',
  )
}

/**
 * 把任意输入（JSON 里的 number / 面板传来的 string）收成正整数；收不出来返回 0。
 *
 * 落在 [MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW] 之外也返回 0（＝当作没配置、回落默认）。
 * 这里不抛错：读盘路径（老 llm.json）和读环境变量都要走它，抛错会让服务起不来。
 * 要让用户看见「你填的数不合法」，走 saveLlmSettings → assertWindowInRange。
 */
function normalizeWindow(value: unknown): number {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return 0
  const rounded = Math.floor(num)
  if (rounded < MIN_CONTEXT_WINDOW || rounded > MAX_CONTEXT_WINDOW) return 0
  return rounded
}

/**
 * 保存前的窗口校验：只拦「填了具体数字、但落在区间外」这一种。
 *
 * 不传 / 空串 / 0 / 解析不出数字 = 「清掉这个字段，回落环境变量或兜底」，属正常操作，放行。
 * 之所以要抛错而不是静默回落 32k：那样用户会在界面上看到「已保存」，分母实际还是 32000，
 * 环永远对不上——这正是让人怀疑「这个数是不是瞎写的」的根源。
 */
function assertWindowInRange(value: number | undefined) {
  if (value === undefined) return
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return
  const rounded = Math.floor(num)
  if (rounded < MIN_CONTEXT_WINDOW || rounded > MAX_CONTEXT_WINDOW) {
    throw new Error(
      `上下文窗口要在 ${MIN_CONTEXT_WINDOW}–${MAX_CONTEXT_WINDOW} tokens 之间（收到 ${rounded}）；不清楚就留空用默认。`,
    )
  }
}

function inferFromEnv(): LlmSettings {
  const apiKey = envKey()
  return {
    mode: apiKey ? 'live' : 'mock',
    apiKey: '',
    baseURL: '',
    model: '',
    contextWindow: envContextWindow() || undefined,
  }
}

function readDisk(): LlmSettings | null {
  try {
    const raw = JSON.parse(fs.readFileSync(llmFile(), 'utf8')) as Partial<LlmSettings>
    if (raw.mode !== 'mock' && raw.mode !== 'live') return null
    return {
      mode: raw.mode,
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
      baseURL: typeof raw.baseURL === 'string' ? raw.baseURL : '',
      model: typeof raw.model === 'string' ? raw.model : '',
      contextWindow: normalizeWindow(raw.contextWindow) || envContextWindow() || undefined,
    }
  } catch {
    return null
  }
}

export function getLlmSettings(): LlmSettings {
  const id = currentUserId()
  let cached = cachedByUser.get(id)
  if (!cached) {
    cached = readDisk() ?? inferFromEnv()
    cachedByUser.set(id, cached)
  }
  return cached
}

/**
 * 面板值 → 环境变量 → 兜底常量（32k，见 DEFAULT_CONTEXT_WINDOW 的注释：它不对应任何模型）。
 * 优先级只在这里算一次，别在 index.ts / 前端各写一份（那样三处必然漂移）。
 */
export function resolveContextWindow(s = getLlmSettings()): number {
  return normalizeWindow(s.contextWindow) || envContextWindow() || DEFAULT_CONTEXT_WINDOW
}

export function publicLlmSettings(s = getLlmSettings()): LlmSettingsPublic {
  return {
    mode: s.mode,
    hasKey: Boolean(s.apiKey.trim() || envKey()),
    baseURL: s.baseURL.trim() || envBase(),
    model: s.model.trim() || envModel(),
    contextWindow: resolveContextWindow(s),
  }
}

export function saveLlmSettings(input: {
  mode: LlmMode
  apiKey?: string
  baseURL?: string
  model?: string
  contextWindow?: number
}): LlmSettingsPublic {
  assertWindowInRange(input.contextWindow)
  const prev = getLlmSettings()
  const next: LlmSettings = {
    mode: input.mode,
    apiKey: input.apiKey?.trim() ? input.apiKey.trim() : prev.apiKey,
    baseURL: input.baseURL !== undefined ? input.baseURL.trim() : prev.baseURL,
    model: input.model !== undefined ? input.model.trim() : prev.model,
    /*
     * 不传（undefined）＝不动这个字段；
     * 传了但收不成正整数（空串 / 0 / 乱写）＝清掉，回落环境变量或兜底常量；
     * 传了合法的数＝存进 llm.json（区间外的在函数开头就被 assertWindowInRange 拦了）。
     * 所以「留空」是有意义的动作：表示「我不知道，用默认」。
     */
    contextWindow:
      input.contextWindow === undefined
        ? prev.contextWindow
        : normalizeWindow(input.contextWindow) || undefined,
  }
  if (next.mode === 'live' && !next.apiKey && !envKey()) {
    throw new Error('LIVE 需要 API Key')
  }
  const file = llmFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
  cachedByUser.set(currentUserId(), next)
  return publicLlmSettings(next)
}

export function resolveLlmFromSettings() {
  const s = getLlmSettings()
  const baseURL = s.baseURL.trim() || envBase() || undefined
  const model = s.model.trim() || envModel()
  const contextWindow = resolveContextWindow(s)
  if (s.mode === 'mock') return { apiKey: '', baseURL, model, contextWindow }
  return { apiKey: s.apiKey.trim() || envKey(), baseURL, model, contextWindow }
}
