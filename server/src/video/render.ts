/**
 * 每一镜先出一张首帧，再按时长铺成片段，ffmpeg 拼成 mp4。
 * 成片还是静帧串起来的，不是图生视频。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { animateStill, wanEnabled } from './animate.js'
import { lockShots, referenceFilesForShot, readBible } from './bible.js'
import { synthesizeSpeech } from './speech.js'
import { generateStill, IMAGE_CENTS } from './still.js'
import { addSpend } from './store.js'
import { listVoices, voicePath } from './voice.js'
import type { Shot } from './types.js'

const CAPTION = path.join(path.dirname(fileURLToPath(import.meta.url)), 'caption.swift')

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

export function shotPng(dir: string, index: number): string {
  return path.join(dir, `shot-${String(index).padStart(2, '0')}.png`)
}

function motion(camera: string, frames: number): string {
  const fit = 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720'
  if (/固定|静止/.test(camera)) return fit
  const wide = 'scale=2560:1440:force_original_aspect_ratio=increase,crop=2560:1440'
  const center = "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
  if (/拉/.test(camera)) {
    return `${wide},zoompan=z='max(1.12-0.12*on/${frames},1)':${center}:d=${frames}:s=1280x720:fps=24`
  }
  if (/摇|移|跟/.test(camera)) {
    return `${wide},zoompan=z='1.08':x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)':d=${frames}:s=1280x720:fps=24`
  }
  return `${wide},zoompan=z='min(1+0.12*on/${frames},1.12)':${center}:d=${frames}:s=1280x720:fps=24`
}

function runText(cmd: string, args: string[]): Promise<void> {
  return run(cmd, args)
}

function mediaDuration(file: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    child.stdout.on('data', (buf) => {
      out += String(buf)
    })
    child.on('close', () => resolve(Number(out) || 0))
    child.on('error', () => resolve(0))
  })
}

/** 对白里写了「名字：」就用那个人的音色，否则用这一镜第一个配了音色的角色。都没有就用音色库第一条。 */
function voiceForShot(shot: Shot): string {
  const bible = readBible()
  const spoken = shot.dialogue.match(/^([^：:（(]{1,16})(?:[（(][^）)]{0,24}[）)])?[：:]/)
  const name = spoken?.[1]?.trim()
  const named = name ? bible.characters.find((item) => item.name === name && item.voiceId) : undefined
  const cast = bible.characters.find((item) => shot.characters.includes(item.name) && item.voiceId)
  const id = named?.voiceId || cast?.voiceId || listVoices()[0]?.id || ''
  return id ? voicePath(id) : ''
}

/** IndexTTS 写成 wav。失败时退回本机 say，那个只出 aiff。 */
async function speak(text: string, stem: string, ref: string): Promise<string | null> {
  const line = text.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!line) return null
  const wav = `${stem}.wav`
  if (await synthesizeSpeech(line, wav, ref)) return wav
  const aiff = `${stem}.aiff`
  try {
    await runText('say', ['-v', 'Tingting', '-o', aiff, line.slice(0, 80)])
    if (fs.existsSync(aiff) && fs.statSync(aiff).size > 0) return aiff
  } catch {
    return null
  }
  return null
}

async function caption(text: string, outFile: string): Promise<boolean> {
  const line = text.replace(/\s+/g, ' ').trim().slice(0, 42)
  if (!line) return false
  try {
    await runText('swift', [CAPTION, outFile, line])
    return fs.existsSync(outFile)
  } catch {
    return false
  }
}

const STILL_AT_ONCE = 3

async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      await fn(item)
    }
  })
  await Promise.all(workers)
}

async function renderShot(dir: string, shot: Shot): Promise<string> {
  const png = shotPng(dir, shot.index)
  const still = { file: fs.existsSync(png.replace(/\.png$/, '.jpg')) ? png.replace(/\.png$/, '.jpg') : png }
  const out = png.replace(/\.png$/, '.mp4')
  const line = shot.dialogue?.trim()
  const card = png.replace(/\.png$/, '.cap.png')
  const voice = line ? await speak(line, png.replace(/\.png$/, ''), voiceForShot(shot)) : null
  const voiced = Boolean(voice)
  const titled = line ? await caption(line, card) : false
  const voiceSec = voiced && voice ? await mediaDuration(voice) : 0
  const wan = png.replace(/\.png$/, '.wan.mp4')
  const silent = png.replace(/\.png$/, '.silent.mp4')
  let picture = silent
  if (wanEnabled()) {
    await animateStill(still.file, shot.description, Math.max(shot.durationSec, voiceSec), wan)
    picture = wan
  } else {
    const frames = Math.max(24, Math.round(Math.max(shot.durationSec, voiceSec) * 24))
    await run('ffmpeg', [
      '-y',
      '-loop',
      '1',
      '-i',
      still.file,
      '-vf',
      motion(shot.camera || '', frames),
      '-frames:v',
      String(frames),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '24',
      silent,
    ])
  }
  const pictureSec = await mediaDuration(picture)
  const hold = Math.max(pictureSec, voiceSec, shot.durationSec)
  if (!voiced && !titled) {
    await run('ffmpeg', [
      '-y',
      '-i',
      picture,
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=44100:cl=stereo',
      '-shortest',
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      picture === wan ? 'copy' : 'libx264',
      ...(picture === wan ? [] : ['-pix_fmt', 'yuv420p']),
      '-c:a',
      'aac',
      '-ar',
      '44100',
      '-ac',
      '2',
      out,
    ])
    if (picture === silent) fs.rmSync(silent, { force: true })
    return out
  }
  const args = ['-y', '-i', picture]
  if (titled) args.push('-i', card)
  if (voice) args.push('-i', voice)
  else args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo')
  const audioIndex = titled ? 2 : 1
  const holdText = hold.toFixed(3)
  const pad = Math.max(0, hold - pictureSec)
  const base = pad > 0.05 ? `[0:v]tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}[base];` : ''
  const videoIn = pad > 0.05 ? 'base' : '0:v'
  if (titled) {
    const shown = voiceSec > 0 ? `:enable='lte(t,${voiceSec.toFixed(3)})'` : ''
    args.push(
      '-filter_complex',
      `${base}[${videoIn}][1:v]overlay=0:0${shown}[v];[${audioIndex}:a]apad=whole_dur=${holdText},aresample=44100,aformat=channel_layouts=stereo[a]`,
      '-map',
      '[v]',
      '-map',
      '[a]',
    )
  } else {
    args.push(
      '-filter_complex',
      `${base}[${audioIndex}:a]apad=whole_dur=${holdText},aresample=44100,aformat=channel_layouts=stereo[a]`,
      '-map',
      pad > 0.05 ? '[base]' : '0:v',
      '-map',
      '[a]',
    )
  }
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-t', holdText)
  if (picture === wan) args.push('-b:v', '10M', '-maxrate', '10M', '-bufsize', '20M')
  else args.push('-r', '24')
  args.push(out)
  await run('ffmpeg', args)
  if (picture === silent) fs.rmSync(silent, { force: true })
  return out
}

/** 拼成片。失败抛错，调用方区分可重试（ffmpeg 崩）和不可重试（没装 ffmpeg）。 */
export async function assemble(
  dir: string,
  shots: Shot[],
  onStill?: (done: number) => void,
  taskId?: string,
): Promise<string> {
  fs.mkdirSync(dir, { recursive: true })
  if (!(await ffmpegAvailable())) {
    const err = new Error('本机没有 ffmpeg，装好后再重试')
    err.name = 'TerminalRenderError'
    throw err
  }
  const locked = lockShots(shots, false)
  let done = 0
  async function writeStill(shot: Shot, face: string): Promise<string> {
    const png = shotPng(dir, shot.index)
    const base = shot.firstFramePrompt || shot.description
    const prompt = face
      ? `只在这张图上改。人物必须是图里的同一个人，五官、发型、肤色、衣服款式都不要变，不要换一张脸。只改动作和景别：${shot.shotSize}。${shot.description}`
      : base
    const refs = face ? [face] : referenceFilesForShot(shot)
    const still = await generateStill(prompt, png, refs)
    if (still.billed && taskId) addSpend(IMAGE_CENTS, taskId)
    done += 1
    onStill?.(done)
    return still.file
  }
  const face = locked.length ? await writeStill(locked[0], '') : ''
  await eachLimit(locked.slice(1), STILL_AT_ONCE, async (shot) => {
    await writeStill(shot, face)
  })
  const clips: string[] = []
  const stopWan = fs.existsSync(path.join(dir, 'stop-wan'))
  for (const shot of locked) {
    if (stopWan) {
      const ready = shotPng(dir, shot.index).replace(/\.png$/, '.mp4')
      if (fs.existsSync(ready) && fs.statSync(ready).size > 8_000) clips.push(ready)
      continue
    }
    clips.push(await renderShot(dir, shot))
  }
  if (!clips.length) throw new Error('没有已经做好的镜头')
  const list = path.join(dir, 'concat.txt')
  fs.writeFileSync(list, clips.map((file) => `file '${file.replace(/'/g, `'\\''`)}'`).join('\n'))
  const out = path.join(dir, 'film.mp4')
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out])
  return out
}
