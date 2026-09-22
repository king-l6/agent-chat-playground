/**
 * 批量入库 wiki：切块 + 文本向量 + 图片 OCR + CLIP 图片向量。
 *
 *   npm run wiki:ingest                    # 全部 578 篇
 *   npm run wiki:ingest -- --limit 3       # 先试 3 篇
 *   npm run wiki:ingest -- --prefix 召回方向  # 只跑某个目录
 *
 * 已经入库过的文档不会重算文本向量（正文指纹没变就整篇跳过），
 * 但每篇的图片都会过一遍：已 OCR 过的图直接读缓存，只补没做过的。
 *
 * 注意：这个脚本会独占 server/data/index.json。跑之前要确认 dev server 没在起，
 * 两个进程同时写会把索引互相盖掉（下面有自动检测，被挡了加 --force 强跑）。
 */
import { getWikiIngestStatus, startWikiIngest } from '../src/retrieve.js'

const args = process.argv.slice(2)
const argVal = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (name: string) => args.includes(`--${name}`)

const PORT = Number(process.env.PLAYGROUND_PORT || process.env.PORT || 8790)

/** 服务在跑就退出：两边同时写 index.json 会互相覆盖 */
async function serverIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
      signal: AbortSignal.timeout(1500),
    })
    return res.ok
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  if (await serverIsUp()) {
    if (!has('force')) {
      console.error(
        `[wiki-ingest] 检测到 http://127.0.0.1:${PORT} 上的服务在跑。\n` +
          '  两个进程同时写 server/data/index.json 会互相覆盖，先停掉服务，\n' +
          '  或者直接打接口：curl -X POST localhost:' +
          PORT +
          '/api/wiki/ingest -H "Content-Type: application/json" -d \'{"all":true}\'\n' +
          '  确实要并行就加 --force。',
      )
      process.exit(1)
    }
    console.warn('[wiki-ingest] 服务在跑，--force 强跑；结束后服务那边的内存索引是旧的。')
  }

  const limitRaw = Number(argVal('limit') ?? 0)
  const status = startWikiIngest({
    prefix: argVal('prefix') || undefined,
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
  })
  console.log(`[wiki-ingest] 开始，共 ${status.total} 篇`)

  const started = Date.now()
  let lastLine = ''
  for (;;) {
    await sleep(5000)
    const s = getWikiIngestStatus()
    const line = `[wiki-ingest] ${s.done}/${s.total} ok=${s.ok} failed=${s.failed} 已用 ${Math.round((Date.now() - started) / 1000)}s`
    if (line !== lastLine) {
      console.log(line)
      lastLine = line
    }
    if (s.current) console.log(`[wiki-ingest]   当前 ${s.current.slice(0, 70)}`)
    if (!s.running) {
      console.log(
        `[wiki-ingest] 完成 ok=${s.ok} failed=${s.failed}，总用时 ${((Date.now() - started) / 1000 / 60).toFixed(1)} 分钟`,
      )
      if (s.error) console.error(`[wiki-ingest] 错误: ${s.error}`)
      break
    }
  }
}

main().catch((err) => {
  console.error('[wiki-ingest] 失败:', err)
  process.exit(1)
})
