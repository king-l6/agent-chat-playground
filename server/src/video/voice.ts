/**
 * 从哔哩哔哩链接截一段连续人声，写成旁白的参考音色。
 * 只按静音切开，不辨认是谁。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA_DIR } from '../paths.js'

export const VOICE_REF = path.join(DATA_DIR, 'index-tts', 'ref.wav')

const BILI = /^https?:\/\/(?:www\.)?bilibili\.com\/video\/(?:BV|av)[\w]+/i
const SHORT = /^https?:\/\/b23\.tv\/[\w]+/i

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${cmd} 超时`))
    }, timeoutMs)
    child.stdout.on('data', (buf) => {
      out += String(buf)
    })
    child.stderr.on('data', (buf) => {
      err += String(buf)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out + err)
      else reject(new Error(err.trim().split('\n').slice(-6).join('\n') || `${cmd} 退出 ${code}`))
    })
  })
}

function speechSpans(log: string): Array<{ start: number; end: number }> {
  const marks: Array<{ kind: 'start' | 'end'; at: number }> = []
  for (const line of log.split('\n')) {
    const start = line.match(/silence_start:\s*([0-9.]+)/)
    const end = line.match(/silence_end:\s*([0-9.]+)/)
    if (start) marks.push({ kind: 'start', at: Number(start[1]) })
    else if (end) marks.push({ kind: 'end', at: Number(end[1]) })
  }
  const spans: Array<{ start: number; end: number }> = []
  let cursor = 0
  for (const mark of marks) {
    if (mark.kind === 'start' && mark.at - cursor >= 4) spans.push({ start: cursor, end: mark.at })
    if (mark.kind === 'end') cursor = mark.at
  }
  return spans
}

function pickSpan(spans: Array<{ start: number; end: number }>): { start: number; seconds: number } {
  const usable = spans
    .map((span) => ({ start: span.start, seconds: span.end - span.start }))
    .filter((span) => span.seconds >= 6 && span.start >= 1)
  const fitted = usable.find((span) => span.seconds >= 8 && span.seconds <= 14)
  const chosen = fitted ?? usable.sort((a, b) => b.seconds - a.seconds)[0]
  if (!chosen) throw new Error('没有找到一段连续的人声')
  const seconds = Math.min(12, chosen.seconds)
  const start = chosen.seconds > 12 ? chosen.start + (chosen.seconds - 12) / 2 : chosen.start
  return { start, seconds }
}

function durationOf(log: string): number {
  const match = log.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!match) return 0
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

/** 静音切不开时（一直有背景声），从靠前的位置直接截一段。 */
function sliceAnyway(log: string): { start: number; seconds: number } {
  const duration = durationOf(log)
  if (duration < 3) throw new Error('这条片子太短，截不出音色')
  const seconds = Math.min(12, duration)
  const start = duration > seconds + 2 ? Math.min(8, duration - seconds) : 0
  return { start, seconds }
}

export type VoiceClip = { id: string; name: string }

const DIR = path.join(DATA_DIR, 'video', 'voices')
const INDEX = path.join(DIR, 'index.json')

function readIndex(): VoiceClip[] {
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX, 'utf8')) as VoiceClip[]
    if (!Array.isArray(raw)) return []
    return raw.filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string')
  } catch {
    return []
  }
}

function writeIndex(items: VoiceClip[]) {
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(INDEX, JSON.stringify(items, null, 2))
}

/** 把已经截好的那一段收进库里，免得设定里没有可选音色。 */
function seedFromRef(items: VoiceClip[]): VoiceClip[] {
  if (items.length || !fs.existsSync(VOICE_REF)) return items
  const id = 'v_current'
  fs.mkdirSync(DIR, { recursive: true })
  fs.copyFileSync(VOICE_REF, path.join(DIR, `${id}.wav`))
  const next = [{ id, name: '这条视频' }]
  writeIndex(next)
  return next
}

export function listVoices(): VoiceClip[] {
  return seedFromRef(readIndex()).filter((item) => fs.existsSync(voicePath(item.id)))
}

export function voicePath(id: string): string {
  return path.join(DIR, `${id.replace(/[^\w-]/g, '')}.wav`)
}

export function removeVoice(id: string) {
  const items = listVoices().filter((item) => item.id !== id)
  fs.rmSync(voicePath(id), { force: true })
  writeIndex(items)
}

export function renameVoice(id: string, name: string): VoiceClip | null {
  const title = name.trim().slice(0, 24)
  if (!title) throw new Error('名字不能空')
  const items = listVoices()
  const hit = items.find((item) => item.id === id)
  if (!hit) return null
  hit.name = title
  writeIndex(items)
  return hit
}

async function clipTo(pageUrl: string, outFile: string): Promise<{ start: number; seconds: number }> {
  const url = pageUrl.trim()
  if (!BILI.test(url) && !SHORT.test(url)) throw new Error('只接受哔哩哔哩视频链接')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-voice-'))
  try {
    try {
      await run('uvx', ['yt-dlp', '-f', 'ba/bestaudio', '--no-playlist', '-o', path.join(dir, 'src.%(ext)s'), url], 180_000)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/404|Not Found/.test(message)) throw new Error('这个链接打不开，视频不存在或 BV 号不完整')
      throw err instanceof Error ? err : new Error(message)
    }
    const downloaded = fs.readdirSync(dir).find((name) => name.startsWith('src.') && !name.endsWith('.part'))
    if (!downloaded) throw new Error('音频没有下下来')
    const source = path.join(dir, downloaded)
    const log = await run('ffmpeg', ['-i', source, '-af', 'silencedetect=noise=-32dB:d=0.35', '-f', 'null', '-'], 120_000)
    const picked = (() => {
      try {
        return pickSpan(speechSpans(log))
      } catch {
        return sliceAnyway(log)
      }
    })()
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    const next = `${outFile}.next.wav`
    await run(
      'ffmpeg',
      ['-y', '-ss', String(picked.start), '-t', String(picked.seconds), '-i', source, '-ac', '1', '-ar', '22050', next],
      60_000,
    )
    fs.renameSync(next, outFile)
    return picked
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export async function addVoice(name: string, pageUrl: string): Promise<VoiceClip & { start: number; seconds: number }> {
  const title = name.trim().slice(0, 24) || '未命名'
  const id = `v_${Date.now().toString(36)}`
  const picked = await clipTo(pageUrl, voicePath(id))
  const items = [...listVoices(), { id, name: title }]
  writeIndex(items)
  return { id, name: title, ...picked }
}
