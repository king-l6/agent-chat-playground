/**
 * 旁白走本机 IndexTTS-2.5。官方仓库按 CUDA 部署，这台是 Apple M1，
 * 用同一模型的 MLX 移植（index-tts-2.5-mlx），不需要登录 Cookie。
 * 模型常驻一个进程，第一句要等权重下载。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_DIR } from '../paths.js'

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'indextts_worker.py')
const REF = path.join(DATA_DIR, 'index-tts', 'ref.wav')

type Ready = { ready?: boolean; ok?: boolean; error?: string }

let child: ChildProcessWithoutNullStreams | null = null
let ready: Promise<void> | null = null
let queue: Promise<void> = Promise.resolve()

function refWav(): string {
  return process.env.INDEX_TTS_REF?.trim() || REF
}

function fail(message: string): Error {
  child?.kill()
  child = null
  ready = null
  return new Error(message)
}

function start(): Promise<void> {
  if (ready && child) return ready
  const proc = spawn(
    'uv',
    ['run', '--with', 'index-tts-2.5-mlx', 'python', WORKER],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HF_ENDPOINT: process.env.HF_ENDPOINT?.trim() || 'https://hf-mirror.com',
      },
    },
  )
  child = proc
  let stderr = ''
  proc.stderr.on('data', (buf) => {
    stderr = (stderr + String(buf)).slice(-2000)
  })
  ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(fail('IndexTTS 启动超时')), 30 * 60_000)
    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += String(chunk)
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      proc.stdout.off('data', onData)
      clearTimeout(timer)
      try {
        const msg = JSON.parse(buf.slice(0, nl)) as Ready
        if (!msg.ready) reject(fail(msg.error || 'IndexTTS 没有就绪'))
        else resolve()
      } catch (err) {
        reject(fail(err instanceof Error ? err.message : 'IndexTTS 启动失败'))
      }
    }
    proc.stdout.on('data', onData)
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(fail(err.message))
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (child === proc) {
        child = null
        ready = null
        reject(fail(stderr.trim() || `IndexTTS 退出 ${code}`))
      }
    })
  })
  return ready
}

function request(text: string, outFile: string, ref: string): Promise<void> {
  const proc = child
  if (!proc) return Promise.reject(new Error('IndexTTS 没在跑'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('IndexTTS 合成超时')), 180_000)
    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += String(chunk)
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      proc.stdout.off('data', onData)
      clearTimeout(timer)
      try {
        const msg = JSON.parse(buf.slice(0, nl)) as Ready
        if (msg.ok) resolve()
        else reject(new Error(msg.error || 'IndexTTS 合成失败'))
      } catch (err) {
        reject(err instanceof Error ? err : new Error('IndexTTS 返回无法解析'))
      }
    }
    proc.stdout.on('data', onData)
    proc.stdin.write(JSON.stringify({ text, out: outFile, ref }) + '\n')
  })
}

/** 参考音色换过之后，下一句旁白重新加载说话人。 */
export function reloadVoice() {
  child?.kill()
  child = null
  ready = null
}

/** 把一句对白合成 wav。模型没起来时返回 false，调用方再退回本机 say。 */
export async function synthesizeSpeech(text: string, outFile: string, ref = refWav()): Promise<boolean> {
  const line = text.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!line || !ref || !fs.existsSync(ref)) return false
  const job = queue.then(async () => {
    await start()
    await request(line, outFile, ref)
  })
  queue = job.then(
    () => undefined,
    () => undefined,
  )
  try {
    await job
    return fs.existsSync(outFile) && fs.statSync(outFile).size > 1000
  } catch (err) {
    console.warn('[tts]', err instanceof Error ? err.message : err)
    return false
  }
}
