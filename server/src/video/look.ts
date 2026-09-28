/**
 * 参考图写出设定文字，或按用户的话改这一句。
 * 有图走视觉模型；只有文字时走分镜那条便宜的文字模型。
 */
import fs from 'node:fs'
import { resolveLlmConfig } from '../agent.js'
import { bibleImageFile } from './bible.js'
import { STORYBOARD_MODEL } from './storyboard.js'

const VISION_MODEL = process.env.VISION_MODEL?.trim() || 'deepseek-v4-flash-vision'

const KIND = {
  character: '写角色固定外形：发型、脸型、五官、体态。不要写衣服，不要写动作。',
  outfit: '写这一件衣服的固定样子：颜色、版型、细节。不要写人物。',
  place: '写这个场景的固定陈设：空间、光线、主要家具。不要写人物。',
} as const

export type LookKind = keyof typeof KIND

function mimeOf(name: string): string {
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}

function clean(raw: string): string {
  return raw
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/i, '')
    .replace(/^["「]|["」]$/g, '')
    .trim()
    .slice(0, 400)
}

export async function reviseLook(input: {
  kind: LookKind
  name: string
  look: string
  images: string[]
  message?: string
}): Promise<string> {
  const files = input.images
    .map((name) => ({ name, file: bibleImageFile(name) }))
    .filter((item): item is { name: string; file: string } => Boolean(item.file))
    .slice(0, 4)
  const message = input.message?.trim() ?? ''
  if (!message && files.length === 0) throw new Error('先放参考图，再写描述')
  if (message && !input.look.trim() && files.length === 0) throw new Error('先放参考图，或先写一句描述')

  const brief = message
    ? `当前描述：${input.look.trim() || '（空）'}\n用户要改：${message}\n按用户的话改描述，没提到的保持原样。只输出改完的描述，不要解释。`
    : `名字：${input.name.trim() || '未命名'}。看这些参考图，${KIND[input.kind]}只输出描述本身，一两句中文。`

  const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [{ type: 'text', text: brief }]
  for (const item of files) {
    const buf = fs.readFileSync(item.file)
    content.push({ type: 'image_url', image_url: { url: `data:${mimeOf(item.name)};base64,${buf.toString('base64')}` } })
  }

  const { apiKey, baseURL } = resolveLlmConfig()
  if (!apiKey || !baseURL) throw new Error('没有可用的模型配置')
  const res = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model: files.length ? VISION_MODEL : STORYBOARD_MODEL,
      temperature: 0.2,
      // 视觉模型会先把额度花在思考上。400 会在正文出来前被截断，内容是空的。
      max_tokens: files.length ? 2000 : 400,
      messages: [{ role: 'user', content: files.length ? content : brief }],
    }),
  })
  const data = (await res.json()) as {
    error?: { message?: string }
    choices?: Array<{
      finish_reason?: string
      message?: { content?: string | Array<{ text?: string }> }
    }>
  }
  if (!res.ok) throw new Error(data.error?.message || `描述没写成 ${res.status}`)
  const choice = data.choices?.[0]
  const body = choice?.message?.content
  const text = typeof body === 'string' ? body : Array.isArray(body) ? body.map((part) => part.text || '').join('\n') : ''
  const look = clean(text)
  if (!look) {
    const reason = choice?.finish_reason
    if (reason === 'content_filter') throw new Error('审核没有放行这段描述')
    if (reason === 'length') throw new Error('模型把额度用在思考上，正文被截断了')
    throw new Error(data.error?.message || '模型没有返回描述')
  }
  return look
}
