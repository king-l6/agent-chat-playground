/**
 * 企微 wiki 抓取器：复用本机登录态，遍历一个 wiki 的整棵目录树，
 * 逐页转 Markdown，POST 到本项目的 /api/knowledge/upload 入知识库。
 *
 * 为什么这么设计：
 *   - 用户不是企微管理员，拿不到服务端 API 授权 → 只能走浏览器自动化复用登录会话。
 *   - 抓取只能在本机跑（有登录 cookie + GUI 浏览器），不能塞进服务端 cron。
 *   - 落库不直连库：本项目没数据库，知识库就是「md 文件 + 本地向量索引」，
 *     已有 /api/knowledge/upload 会自动切块 + 向量化，等价于页面手动传文档。
 *
 * wiki 的目录树 / 正文都是前端异步渲染，DOM 选择器无法离线写死，
 * 所以对目录节点、正文容器都配了多个候选选择器兜底，并提供 --probe 模式
 * 打印页面真实结构，方便按你的企微版本微调 SELECTORS。
 *
 * 用法：
 *   npm run crawl:wework -- --url "<wiki 链接>" --probe        # 只探测结构，不抓
 *   npm run crawl:wework -- --url "<wiki 链接>" --once          # 抓一遍退出
 *   npm run crawl:wework -- --url "<wiki 链接>" --interval 1800 # 每 30 分钟增量常驻
 *
 * 首次运行会弹出浏览器，请扫码登录一次；登录态存在独立 profile 目录，之后复用。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { chromium, type BrowserContext, type Page } from 'playwright'
import TurndownService from 'turndown'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// server/scripts → 仓库根
const REPO_ROOT = path.resolve(__dirname, '../..')
const DATA_DIR = path.join(REPO_ROOT, 'server', 'data')
// 登录态：独立 profile，绝不碰用户真实 Chrome，避免 profile 锁冲突
const PROFILE_DIR = path.join(DATA_DIR, '.wework-profile')
// 增量去重状态：pageId → { hash, docId, title }
const STATE_PATH = path.join(DATA_DIR, '.wework-crawl-state.json')

const UPLOAD_BASE = process.env.PLAYGROUND_API || 'http://127.0.0.1:8790'

// —— 候选选择器：企微版本不同可能要调，用 --probe 打印真实结构后核对 ——
// 实测（wiki w.ANYAEAdoABE.*）：左侧目录不是 <a> 链接，而是靠 JS 点击切换的节点；
// 正文在名为 editor 的 iframe 里。所以遍历靠"逐个点击目录节点"，不是收集 href。
const SELECTORS = {
  // 左侧目录树里可点击的节点（点它会切换正文）
  treeNodes: [
    '.wiki-doc-title-text',
    '.wiki-doc-title',
    '.wiki-doc-node-main',
    '[class*="wiki-doc-node"] [class*="title"]',
  ],
  // 正文容器（在某个 iframe 内，取到就转 markdown）
  content: [
    '[class*="editor"] [contenteditable]',
    '.doc-render',
    '.wiki-content',
    '.ProseMirror',
    'article',
  ],
}

type CrawlState = Record<string, { hash: string; docId: string; title: string }>

type Args = {
  url: string
  probe: boolean
  once: boolean
  interval: number
  limit: number
}

function parseArgs(argv: string[]): Args {
  let url = ''
  let interval = 0
  let limit = 0
  const probe = argv.includes('--probe')
  const once = argv.includes('--once')
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url' && argv[i + 1]) url = argv[++i]
    else if (argv[i] === '--interval' && argv[i + 1]) interval = Number(argv[++i])
    else if (argv[i] === '--limit' && argv[i + 1]) limit = Number(argv[++i])
  }
  return { url, probe, once, interval, limit }
}

function readState(): CrawlState {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as CrawlState
  } catch {
    return {}
  }
}

function writeState(state: CrawlState) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
}

/** 从企微文档 URL 里抽稳定 id（/doc/xxx 或 /wiki/xxx 那段），抽不到就用整个 URL */
function pageIdFromUrl(url: string): string {
  const m = url.match(/\/(?:doc|wiki|sheet)\/([A-Za-z0-9_.-]+)/)
  return m ? m[1] : crypto.createHash('md5').update(url).digest('hex').slice(0, 16)
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 文件名安全化：去掉路径分隔符和控制字符，限长 */
function safeFileName(title: string): string {
  const clean = title.replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').trim().slice(0, 80)
  return `${clean || 'untitled'}.md`
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})

/** 在一堆候选选择器里挑第一个真的选到东西的 */
async function firstMatching(page: Page, selectors: string[]): Promise<string | null> {
  for (const sel of selectors) {
    const count = await page.locator(sel).count().catch(() => 0)
    if (count > 0) return sel
  }
  return null
}

/** 等页面主要内容渲染完（企微是 SPA，networkidle + 兜底延时） */
async function waitReady(page: Page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
  await sleep(2000)
}

/** 等用户在浏览器里操作完（登录 / 展开目录），回车继续 */
function waitEnter(prompt: string): Promise<void> {
  console.log(prompt)
  return new Promise<void>((resolve) => {
    process.stdin.resume()
    process.stdin.once('data', () => resolve())
  })
}

/**
 * --probe：打印页面结构，帮你核对/调整 SELECTORS。
 * 企微文档标题常停在「Loading」且正文在 iframe 里，所以先等你手动登录 + 展开目录，
 * 回车后再遍历主页面和所有 iframe，逐个 frame 打印命中情况与真实链接。
 */
async function probe(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await waitReady(page)
  await waitEnter(
    '\n浏览器已打开。请在里面：1) 若要求登录就扫码；2) 手动把左侧目录完全展开；3) 等正文加载出来。\n都就绪后回到这里按【回车】开始探测…',
  )

  console.log('\n===== PROBE =====')
  console.log('页面标题:', await page.title())
  console.log('当前 URL:', page.url())

  // 主页面 + 所有 iframe 都要查（企微正文常在 iframe 内）
  const frames = page.frames()
  console.log(`\n共 ${frames.length} 个 frame（含主页面）`)

  for (const frame of frames) {
    const tag = frame === page.mainFrame() ? '主页面' : `iframe: ${frame.url().slice(0, 80)}`
    console.log(`\n———— [${tag}] ————`)

    console.log('-- 目录节点候选选择器命中数 --')
    for (const sel of SELECTORS.treeNodes) {
      const n = await frame.locator(sel).count().catch(() => 0)
      if (n > 0) console.log(`  ✓ ${sel} → ${n}`)
    }
    console.log('-- 正文容器候选选择器命中数 --')
    for (const sel of SELECTORS.content) {
      const n = await frame.locator(sel).count().catch(() => 0)
      if (n > 0) console.log(`  ✓ ${sel} → ${n}`)
    }

    // 这个 frame 里所有 a 链接（前 30），看目录树到底长啥样
    const links = await frame
      .$$eval('a[href]', (as) =>
        as
          .map((a) => ({ href: (a as HTMLAnchorElement).href, text: (a.textContent || '').trim() }))
          .filter((x) => /\/(doc|wiki|sheet)\//.test(x.href))
          .slice(0, 30),
      )
      .catch(() => [] as Array<{ href: string; text: string }>)
    if (links.length) {
      console.log(`-- doc/wiki 链接（前 ${links.length}）--`)
      links.forEach((l) => console.log(`  [${l.text.slice(0, 30)}] ${l.href}`))
    }

    // 打印这个 frame body 里出现频率最高的 class，帮我们找正文/目录容器
    const topClasses = await frame
      .$$eval('body *', (els) => {
        const count: Record<string, number> = {}
        for (const el of els) {
          for (const c of Array.from(el.classList)) count[c] = (count[c] || 0) + 1
        }
        return Object.entries(count)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 25)
      })
      .catch(() => [] as Array<[string, number]>)
    if (topClasses.length) {
      console.log('-- 高频 class（前 25，用来猜容器）--')
      console.log('  ' + topClasses.map(([c, n]) => `${c}(${n})`).join('  '))
    }
  }
  console.log('\n===== /PROBE =====\n')
}

/** 展开左侧目录里所有可折叠节点，尽量把深层页面点出来 */
async function expandTree(page: Page) {
  for (let round = 0; round < 6; round += 1) {
    // 折叠箭头：实测是 wedocs-icon-tdoc-caret-right-16 这类右向箭头
    const carets = page.locator('[class*="caret-right"], [class*="arrow"], [class*="toggle"]')
    const n = await carets.count().catch(() => 0)
    if (n === 0) break
    let clicked = 0
    for (let i = 0; i < n; i += 1) {
      const ok = await carets.nth(i).click({ timeout: 800 }).then(() => true).catch(() => false)
      if (ok) clicked += 1
    }
    await sleep(600)
    if (clicked === 0) break
  }
}

/**
 * 找到正文所在的 editor iframe（contenteditable 那个）。
 * 企微正文是 canvas 渲染，DOM 里没有文字，所以只用它来聚焦+全选，不读 innerHTML。
 */
function findEditorFrame(page: Page) {
  for (const frame of page.frames()) {
    if (/\/doc\/w3_/.test(frame.url())) return frame
  }
  return null
}

/**
 * 提取正文：企微文档正文在 canvas 上，DOM 读不到。
 * 手动 Cmd+A / Cmd+C 能复制成功，说明文档 JS 会在 copy 事件里往 clipboardData 写 text/html。
 * 所以这里在正文 frame 内挂一个 copy 事件监听，从源头截获数据，
 * 绕开 navigator.clipboard.read() 在自动化环境下的焦点/权限限制。
 */
async function extractContentHtml(page: Page, timeoutMs = 15000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

  while (Date.now() < deadline) {
    const frame = findEditorFrame(page)
    const editable = frame?.locator('[contenteditable]').first()
    const ok = editable ? await editable.count().then((n) => n > 0).catch(() => false) : false
    if (frame && editable && ok) {
      try {
        // 1) 在正文 frame 里挂一次性 copy 捕获器，把 clipboardData 存到 window
        await frame.evaluate(() => {
          const w = window as unknown as { __copyHtml?: string; __copyText?: string }
          w.__copyHtml = ''
          w.__copyText = ''
          const handler = (e: Event) => {
            const ce = e as ClipboardEvent
            try {
              w.__copyHtml = ce.clipboardData?.getData('text/html') || ''
              w.__copyText = ce.clipboardData?.getData('text/plain') || ''
            } catch {
              /* ignore */
            }
          }
          document.addEventListener('copy', handler, { capture: true, once: true })
        })

        // 2) 聚焦正文 → 全选 → 复制（触发文档自己的 copy handler）
        await editable.click({ timeout: 3000, force: true }).catch(() => {})
        await sleep(300)
        await page.keyboard.press(`${mod}+a`)
        await sleep(400)
        await page.keyboard.press(`${mod}+c`)
        await sleep(800)

        // 3) 读回被截获的数据
        const got = await frame.evaluate(() => {
          const w = window as unknown as { __copyHtml?: string; __copyText?: string }
          return { html: w.__copyHtml || '', text: w.__copyText || '' }
        })

        if (got.html && got.html.replace(/<[^>]+>/g, '').trim().length > 5) return got.html
        if (got.text && got.text.trim().length > 5) {
          return `<pre>${got.text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))}</pre>`
        }
      } catch {
        /* 重试到超时 */
      }
    }
    await sleep(800)
  }
  return ''
}

/** 诊断：取不到正文时，打印每个 frame 的 URL / 选择器命中 / 正文前 100 字，定位正文真实位置 */
async function dumpFrames(page: Page) {
  console.log('    ---- frame 诊断 ----')
  for (const frame of page.frames()) {
    const tag = frame === page.mainFrame() ? '主页面' : `iframe ${frame.url().slice(0, 70)}`
    const bodyText = await frame
      .locator('body')
      .innerText()
      .then((t) => t.trim().replace(/\s+/g, ' ').slice(0, 100))
      .catch(() => '(读不到)')
    console.log(`    [${tag}] body 前100字: ${bodyText}`)
    for (const sel of SELECTORS.content) {
      const n = await frame.locator(sel).count().catch(() => 0)
      if (n > 0) {
        const len = await frame.locator(sel).first().innerText().then((t) => t.trim().length).catch(() => 0)
        console.log(`      命中 ${sel} → ${n} 个，首个文本长度 ${len}`)
      }
    }
  }
  console.log('    ---- /frame 诊断 ----')
}

/** 把正文 HTML 转成带标题/来源的 Markdown */
function toMarkdown(title: string, url: string, html: string): string | null {
  const md = turndown.turndown(html).trim()
  if (md.length < 10) return null
  return `# ${title}\n\n> 来源: ${url}\n\n${md}\n`
}

/** 上传一篇到知识库；先删旧 docId（内容变更时）再传新的 */
async function uploadDoc(fileName: string, markdown: string, oldDocId?: string): Promise<string> {
  if (oldDocId) {
    await fetch(`${UPLOAD_BASE}/api/knowledge/docs/${encodeURIComponent(oldDocId)}`, {
      method: 'DELETE',
    }).catch(() => {})
  }
  const form = new FormData()
  form.append('file', new Blob([markdown], { type: 'text/markdown' }), fileName)
  const resp = await fetch(`${UPLOAD_BASE}/api/knowledge/upload`, { method: 'POST', body: form })
  if (!resp.ok) {
    throw new Error(`上传失败 ${resp.status}: ${await resp.text()}`)
  }
  const data = (await resp.json()) as { docId: string }
  return data.docId
}

/**
 * 跑一遍：逐个点击左侧目录节点 → 等正文切换 → 抓 iframe 正文 → 增量上传。
 * 企微 wiki 目录不是 <a>，靠点击切换正文，所以用节点索引遍历、以点击后的 URL 作去重 id。
 */
async function crawlOnce(context: BrowserContext, entryUrl: string, limit = 0) {
  const state = readState()
  const page = await context.newPage()

  console.log('=== 抓取器 v3（剪贴板模式）===')
  console.log(`[${new Date().toLocaleString()}] 打开入口页…`)
  await page.goto(entryUrl, { waitUntil: 'domcontentloaded' })
  await waitReady(page)
  await expandTree(page)

  const nodeSel = await firstMatching(page, SELECTORS.treeNodes)
  if (!nodeSel) {
    console.warn('[warn] 没找到目录节点，只抓当前这一页。跑 --probe 看看结构')
  }
  const nodes = nodeSel ? page.locator(nodeSel) : null
  const total = nodes ? await nodes.count() : 0
  console.log(`发现 ${total} 个目录节点`)

  let uploaded = 0
  let skipped = 0
  let failed = 0
  const seen = new Set<string>()

  // 逐个点击目录节点。没有节点时也至少抓当前页一次。
  // --limit 按「尝试过的去重页数」算，不管成功失败，试够就停（验证时不再空跑整列）。
  const rounds = limit > 0 ? Math.min(Math.max(total, 1), limit) : Math.max(total, 1)
  for (let i = 0; i < rounds; i += 1) {
    if (limit > 0 && seen.size >= limit) {
      console.log(`已尝试 ${seen.size} 个页面，达 --limit ${limit}，停止`)
      break
    }
    try {
      if (nodes && total > 0) {
        await nodes.nth(i).scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {})
        await nodes.nth(i).click({ timeout: 3000 })
        await sleep(1500)
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
      }

      const url = page.url()
      const id = pageIdFromUrl(url)
      if (seen.has(id)) continue
      seen.add(id)

      const html = await extractContentHtml(page)
      if (!html) {
        failed += 1
        console.warn(`  ! 未取到正文，跳过: ${url}`)
        // 前 2 次失败打印 frame 诊断，帮我们定位正文真实位置
        if (failed <= 2) await dumpFrames(page)
        continue
      }
      const rawTitle = (await page.title()).replace(/\s*-\s*(企业微信|腾讯文档).*$/, '').trim()
      const title = rawTitle && rawTitle !== 'Loading' ? rawTitle : id
      const markdown = toMarkdown(title, url, html)
      if (!markdown) {
        failed += 1
        console.warn(`  ! 正文过短，跳过: ${title}`)
        continue
      }

      const hash = sha256(markdown)
      const prev = state[id]
      if (prev && prev.hash === hash) {
        skipped += 1
        console.log(`  = 未变化，跳过: ${title}`)
      } else {
        const docId = await uploadDoc(safeFileName(title), markdown, prev?.docId)
        state[id] = { hash, docId, title }
        writeState(state)
        uploaded += 1
        console.log(`  ${prev ? '↻ 更新' : '+ 新增'}: ${title} → ${docId}`)
      }
      // --limit：只抓前 N 篇（成功入库计数），用来验证选择器
      if (limit > 0 && uploaded + skipped >= limit) {
        console.log(`已达 --limit ${limit}，提前停止`)
        break
      }
    } catch (err) {
      failed += 1
      console.warn(`  ! 第 ${i + 1} 个节点抓取失败:`, err instanceof Error ? err.message : err)
    }
    // 节流：每页之间随机等 2~5 秒
    await sleep(2000 + Math.random() * 3000)
  }

  await page.close()
  console.log(`本轮完成：新增/更新 ${uploaded}，跳过 ${skipped}，失败 ${failed}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.url) {
    console.error('缺少 --url "<wiki 链接>"')
    process.exit(1)
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true })
  // headless:false 让首次能扫码登录；已登录后无头也能跑，但保持有头便于观察
  // 企微文档正文是 canvas 渲染，DOM 里没有文字，只能靠「全选+复制」读剪贴板，
  // 所以要授予剪贴板读写权限。
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  })

  try {
    if (args.probe) {
      const page = await context.newPage()
      await probe(page, args.url)
      await page.close()
      return
    }

    // 首跑给足时间扫码：先打开入口页，若被要求登录，用户手动扫码后回车继续
    const check = await context.newPage()
    await check.goto(args.url, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await waitReady(check)
    if (/登录|login|扫码|weixin\.qq\.com\/.*login/i.test(await check.content())) {
      console.log('\n看起来需要登录，请在弹出的浏览器里扫码登录，登录完成后回到这里按回车继续…')
      await new Promise<void>((resolve) => {
        process.stdin.resume()
        process.stdin.once('data', () => resolve())
      })
    }
    await check.close()

    do {
      await crawlOnce(context, args.url, args.limit)
      if (args.interval > 0 && !args.once) {
        console.log(`等待 ${args.interval}s 后跑下一轮增量…（Ctrl+C 停止）`)
        await sleep(args.interval * 1000)
      }
    } while (args.interval > 0 && !args.once)
  } finally {
    await context.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
