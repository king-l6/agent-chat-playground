/**
 * 每一镜的首帧。走网关上的 gpt-image-2，返回 PNG。
 * 已经落盘的图直接复用，重试不会再出一张。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveLlmConfig } from '../agent.js'

export const IMAGE_MODEL = 'gpt-image-2'

type ImageResponse = {
  data?: Array<{ b64_json?: string }>
  error?: { message?: string }
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (buf) => {
      err += String(buf)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(err.trim().split('\n').slice(-3).join('\n') || `ffmpeg 退出 ${code}`))
    })
  })
}

/** 出图结果里夹着 C2PA，原样再传会被网关认成未知类型。压成一张干净的 jpeg。 */
async function plainJpeg(file: string): Promise<Buffer> {
  const tmp = path.join(os.tmpdir(), `still-ref-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}.jpg`)
  try {
    await ffmpeg(['-y', '-i', file, '-map_metadata', '-1', '-frames:v', '1', '-q:v', '3', tmp])
    return fs.readFileSync(tmp)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

async function fetchImage(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error('出图超过 5 分钟还没返回')
    }
    throw err
  }
}

async function requestImage(prompt: string, size: string): Promise<Buffer> {
  const { apiKey, baseURL } = resolveLlmConfig()
  if (!apiKey || !baseURL) {
    const err = new Error('没有出图网关，配好 OPENAI_BASE_URL 和 Key 再开')
    err.name = 'TerminalRenderError'
    throw err
  }
  const res = await fetchImage(`${baseURL.replace(/\/$/, '')}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt,
      n: 1,
      size,
    }),
    signal: AbortSignal.timeout(300_000),
  })
  const data = (await res.json()) as ImageResponse
  if (!res.ok) {
    const message = data.error?.message || `出图失败 ${res.status}`
    if (res.status === 400 && size !== '1024x1024') {
      return requestImage(prompt, '1024x1024')
    }
    throw new Error(message)
  }
  const b64 = data.data?.[0]?.b64_json
  if (!b64) throw new Error('出图接口没有返回图片')
  return Buffer.from(b64, 'base64')
}

async function requestEdit(prompt: string, size: string, refs: string[]): Promise<Buffer> {
  const { apiKey, baseURL } = resolveLlmConfig()
  if (!apiKey || !baseURL) {
    const err = new Error('没有出图网关，配好 OPENAI_BASE_URL 和 Key 再开')
    err.name = 'TerminalRenderError'
    throw err
  }
  const form = new FormData()
  form.append('model', IMAGE_MODEL)
  form.append('prompt', prompt)
  form.append('n', '1')
  form.append('size', size)
  for (const file of refs) {
    const jpeg = await plainJpeg(file)
    form.append('image', new File([new Uint8Array(jpeg)], 'ref.jpg', { type: 'image/jpeg' }))
  }
  const res = await fetchImage(`${baseURL.replace(/\/$/, '')}/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(300_000),
  })
  const data = (await res.json()) as ImageResponse
  if (!res.ok) {
    const message = data.error?.message || `参考图出图失败 ${res.status}`
    if (res.status === 400 && size !== '1024x1024') return requestEdit(prompt, '1024x1024', refs)
    throw new Error(message)
  }
  const b64 = data.data?.[0]?.b64_json
  if (!b64) throw new Error('出图接口没有返回图片')
  return Buffer.from(b64, 'base64')
}

export async function renderReference(prompt: string, size = '1024x1024'): Promise<Buffer> {
  return requestImage(`${prompt}。不要任何文字、字幕、水印。`, size)
}

/** 对话出图。有上一张就在那张上改，没有就按参考图或纯文字出一张。 */
export async function drawRevision(prompt: string, size: string, refs: string[]): Promise<Buffer> {
  const text = `${prompt}。不要任何文字、字幕、水印。`
  return refs.length ? requestEdit(text, size, refs) : requestImage(text, size)
}

/** 记账单价：每新出一张 gpt-image-2 记 0.40 元，用来卡住日限额。复用旧图不计。 */
export const IMAGE_CENTS = 40

export async function generateStill(
  prompt: string,
  outFile: string,
  refs: string[] = [],
): Promise<{ file: string; billed: boolean }> {
  const jpg = outFile.replace(/\.png$/, '.jpg')
  const stampFile = `${outFile}.prompt.txt`
  const stamp = `${prompt}\n${refs.map((file) => path.basename(file)).join(',')}`
  const kept = (file: string) => fs.existsSync(file) && fs.statSync(file).size > 8_000
  const same = fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === stamp
  if (same && kept(outFile)) return { file: outFile, billed: false }
  if (same && kept(jpg)) return { file: jpg, billed: false }
  const bytes = refs.length
    ? await requestEdit(
        `${prompt}。只画这一镜的单幅画面，不要分格，不要拼图。画面里不要任何文字、字幕、对白、水印。`,
        '1536x1024',
        refs,
      )
    : await requestImage(
        `${prompt}。只画这一镜的单幅画面，不要分格，不要拼图。画面里不要任何文字、字幕、对白、水印。`,
        '1536x1024',
      )
  const hex = bytes.subarray(0, 4).toString('hex')
  const file = hex.startsWith('ffd8') ? jpg : outFile
  if (!hex.startsWith('89504e47') && !hex.startsWith('ffd8')) {
    throw new Error(`出图结果不是图片（${hex}）`)
  }
  fs.writeFileSync(file, bytes)
  fs.writeFileSync(stampFile, stamp)
  return { file, billed: true }
}
