/**
 * 静帧交给万相参考生视频（免费额度在这个模型上）。
 * 没配 DASHSCOPE_API_KEY 时不调用。已经落盘的动作视频直接复用。
 */
import fs from 'node:fs'
import path from 'node:path'

const HOST = 'https://dashscope.aliyuncs.com/api/v1'
export const WAN_MODEL = 'wan2.7-r2v-2026-06-12'

type Policy = {
  policy: string
  signature: string
  upload_dir: string
  upload_host: string
  oss_access_key_id: string
  x_oss_object_acl?: string
  x_oss_forbid_overwrite?: string
}

type TaskBody = {
  output?: { task_id?: string; task_status?: string; video_url?: string; message?: string; code?: string }
  message?: string
}

function key(): string {
  return process.env.DASHSCOPE_API_KEY?.trim() || ''
}

export function wanEnabled(): boolean {
  return Boolean(key())
}

async function readJson(res: Response): Promise<TaskBody & { data?: Policy }> {
  const data = (await res.json()) as TaskBody & { data?: Policy }
  if (!res.ok) throw new Error(data.output?.message || data.message || `万相请求失败 ${res.status}`)
  return data
}

async function uploadStill(file: string): Promise<string> {
  const policyRes = await fetch(`${HOST}/uploads?action=getPolicy&model=${WAN_MODEL}`, {
    headers: { Authorization: `Bearer ${key()}` },
  })
  const policyBody = await readJson(policyRes)
  const policy = policyBody.data
  if (!policy?.upload_host || !policy.upload_dir) throw new Error('万相没有返回上传地址')
  const name = `shot${path.extname(file) || '.png'}`
  const objectKey = `${policy.upload_dir}/${name}`
  const form = new FormData()
  form.append('OSSAccessKeyId', policy.oss_access_key_id)
  form.append('policy', policy.policy)
  form.append('Signature', policy.signature)
  form.append('key', objectKey)
  form.append('x-oss-object-acl', policy.x_oss_object_acl || 'private')
  form.append('x-oss-forbid-overwrite', policy.x_oss_forbid_overwrite || 'true')
  form.append('success_action_status', '200')
  form.append('file', new Blob([new Uint8Array(fs.readFileSync(file))]), name)
  const up = await fetch(policy.upload_host, { method: 'POST', body: form })
  if (!up.ok) throw new Error(`静帧上传失败 ${up.status}`)
  return `oss://${objectKey}`
}

async function waitVideo(taskId: string): Promise<string> {
  const deadline = Date.now() + 8 * 60_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000))
    const res = await fetch(`${HOST}/tasks/${taskId}`, { headers: { Authorization: `Bearer ${key()}` } })
    const body = await readJson(res)
    const status = body.output?.task_status
    if (status === 'SUCCEEDED' && body.output?.video_url) return body.output.video_url
    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
      throw new Error(body.output?.message || `万相任务${status}`)
    }
  }
  throw new Error('万相超过 8 分钟还没出视频')
}

/** 用这一镜的静帧和动作说明生成视频。outFile 已存在则直接返回。 */
export async function animateStill(imageFile: string, action: string, seconds: number, outFile: string): Promise<void> {
  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 8_000) return
  const oss = await uploadStill(imageFile)
  const duration = Math.min(15, Math.max(2, Math.round(seconds)))
  const created = await readJson(
    await fetch(`${HOST}/services/aigc/video-generation/video-synthesis`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key()}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
        'X-DashScope-OssResourceResolve': 'enable',
      },
        body: JSON.stringify({
        model: WAN_MODEL,
        input: {
          prompt: `参考图片里的人物做这个动作：${action}。不要说话，不要出现文字。`,
          media: [{ type: 'reference_image', url: oss }],
        },
        parameters: { resolution: '720P', ratio: '16:9', duration, prompt_extend: false, watermark: false },
      }),
    }),
  )
  const taskId = created.output?.task_id
  if (!taskId) throw new Error('万相没有返回任务')
  const url = await waitVideo(taskId)
  const video = await fetch(url)
  if (!video.ok) throw new Error(`动作视频下载失败 ${video.status}`)
  fs.writeFileSync(outFile, Buffer.from(await video.arrayBuffer()))
}
