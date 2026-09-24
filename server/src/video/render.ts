/**
 * 本地成片：每个分镜一段纯色画面加字，ffmpeg concat 成一条 mp4。
 * 这是供应商没接上之前的竖切。画面是分镜板，不是图生视频。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Shot } from './types.js'

const FONT = '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (buf) => {
      err += String(buf)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(err.trim().split('\n').slice(-4).join('\n') || `${cmd} 退出 ${code}`))
    })
  })
}

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await run('ffmpeg', ['-version'])
    return true
  } catch {
    return false
  }
}

function wrap(text: string, width: number): string[] {
  const chars = [...text.replace(/\s+/g, ' ').trim()]
  const lines: string[] = []
  for (let i = 0; i < chars.length && lines.length < 4; i += width) {
    lines.push(chars.slice(i, i + width).join(''))
  }
  return lines.length ? lines : [' ']
}

function writeLine(file: string, text: string): void {
  fs.writeFileSync(file, text)
}

async function renderShot(dir: string, shot: Shot): Promise<string> {
  const base = path.join(dir, `shot-${String(shot.index).padStart(2, '0')}`)
  const meta = `${base}.meta.txt`
  const body = `${base}.body.txt`
  writeLine(meta, `${String(shot.index).padStart(2, '0')}  ${shot.shotSize}  ${shot.durationSec}s  ${shot.camera}`)
  writeLine(body, wrap(shot.description, 18).join('\n'))
  const out = `${base}.mp4`
  const font = fs.existsSync(FONT) ? FONT : ''
  const filters = [
    'drawbox=x=0:y=0:w=14:h=ih:color=0xc45c26:t=fill',
    font
      ? `drawtext=fontfile='${font}':textfile='${meta}':fontsize=28:fontcolor=0xF4F1EA:x=48:y=48`
      : '',
    font
      ? `drawtext=fontfile='${font}':textfile='${body}':fontsize=36:fontcolor=0xF4F1EA:x=48:y=140:line_spacing=12`
      : '',
  ].filter(Boolean)
  await run('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x1c2832:s=1280x720:d=${shot.durationSec}`,
    '-vf',
    filters.join(','),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '24',
    out,
  ])
  return out
}

/** 拼成片。失败抛错，调用方区分可重试（ffmpeg 崩）和不可重试（没装 ffmpeg）。 */
export async function assemble(dir: string, shots: Shot[]): Promise<string> {
  fs.mkdirSync(dir, { recursive: true })
  if (!(await ffmpegAvailable())) {
    const err = new Error('本机没有 ffmpeg，装好后再重试')
    err.name = 'TerminalRenderError'
    throw err
  }
  const clips: string[] = []
  for (const shot of shots) clips.push(await renderShot(dir, shot))
  const list = path.join(dir, 'concat.txt')
  fs.writeFileSync(list, clips.map((file) => `file '${file.replace(/'/g, `'\\''`)}'`).join('\n'))
  const out = path.join(dir, 'film.mp4')
  await run('ffmpeg', [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-c',
    'copy',
    out,
  ])
  return out
}
