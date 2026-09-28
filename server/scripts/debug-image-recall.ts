/**
 * 图片召回探针：为什么「用户要原图」时一张都命中不了。
 *
 *   npx tsx server/scripts/debug-image-recall.ts                     # 跑内置探针集
 *   npx tsx server/scripts/debug-image-recall.ts "平台渗透率 图 周报"  # 只跑这几句
 *
 * 打两件事：
 * 1) CLIP 能不能加载（加载失败时 searchImages 静默返回 []，检索侧毫无信号）
 * 2) 每句查询对全库 1668 张图的余弦分布——MIN_IMAGE_COSINE=0.26 是唯一的门槛，
 *    只读探针才能看出「差一点点」和「压根不在一个空间」的区别。
 *
 * 只读：不编码图片、不写 image-index.json。
 */
import fs from 'node:fs'
import { IMAGE_INDEX_PATH, type ImageIndexItem } from '../src/imageIndex.js'
import { imageCacheId, imageFileById } from '../src/imageCache.js'
import { INDEX_PATH } from '../src/knowledge.js'
import { getVlEmbedError, embedVlQuery, tryLoadVlEmbedder } from '../src/vlEmbed.js'
import { decodeVector } from '../src/vectorCodec.js'
import { HYBRID_CANDIDATES, attachReferencedImages, fuseRrf, groupByDoc } from '../src/retrieve.js'
// SearchHit 声明在 knowledge.ts，retrieve.ts 只是引进来用，别从那儿转手导
import type { SearchHit } from '../src/knowledge.js'

const MIN_IMAGE_COSINE = 0.26

const DEFAULT_QUERIES = [
  '平台渗透率 图 周报',
  '平台渗透率',
  '周报里的那张图',
  '把原图发我',
]

type Stored = { id: string; docId: string; title: string; v?: string; embedding?: number[] }

function loadItems(): ImageIndexItem[] {
  const file = JSON.parse(fs.readFileSync(IMAGE_INDEX_PATH, 'utf8')) as { items: Stored[] }
  return file.items.map((it) => ({
    ...it,
    embedding: it.v ? decodeVector(it.v) : it.embedding ?? [],
  })) as ImageIndexItem[]
}

function cosine(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) s += a[i] * b[i]
  return s
}

/**
 * 复现「图片命中进不了最终 hits」：拿真实形状的候选喂 fuseRrf + groupByDoc。
 *
 * 文本侧候选照抄 2026-09-22 那次实测（问「平台渗透率 图 周报」，工具卡片里 6 条）：
 * W1 那篇 w_e62e19bff8aaacbb 占 2 条，另外 4 篇各 1 条——RRF 只认名次，
 * 所以只要名次顺序对，分数量级不用抄。图片侧用本次 CLIP 真实打分的前 6 名。
 */
async function fusionCase(query: string, items: ImageIndexItem[]) {
  const qv = await embedVlQuery(query)
  const imageHits: SearchHit[] = items
    .map((it) => ({ it, score: cosine(qv, it.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((x, i) => ({
      id: x.it.id,
      docId: x.it.docId,
      title: `图片 · ${x.it.title}`,
      text: '',
      citation: i + 1,
      score: x.score,
      imageUrl: `/api/image/cache/${x.it.id}`,
    }))

  const textDocIds = [
    'w_e62e19bff8aaacbb',
    'w_e62e19bff8aaacbb',
    'w_c295c4692620c5bf',
    'w_3d72ac9a98a58f3b',
    'w_0520abb9af8de5ca',
    'w_6b0940a8da3689b1',
  ]
  const textHits: SearchHit[] = textDocIds.map((docId, i) => ({
    id: `${docId}-c${i + 1}`,
    docId,
    title: '文本块',
    text: '',
    citation: i + 1,
    score: 0,
  }))

  // 照抄 retrieve() 的调用形态：融合池 HYBRID_CANDIDATES(topK=3)，权重 [1, 0.85]
  const fused = fuseRrf([textHits, imageHits], HYBRID_CANDIDATES(3), [1, 0.85])
  // 再照抄 assembleHits 的收尾（:1088-1092）：聚篇 → 按分排 → 砍到 topK × CHUNKS_PER_DOC
  const budget = 3 * 2
  const picked = groupByDoc(fused)
    .sort((a, b) => b.score - a.score)
    .slice(0, budget)
  const imgs = picked.filter((h) => h.imageUrl)
  const show = (h: SearchHit) => `${h.id.slice(0, 22).padEnd(24)} ${h.score.toFixed(4)}`
  console.log(`\n融合后（${fused.length} 条）：`)
  for (const h of fused) console.log('  ' + show(h))
  console.log(`聚篇 + 按分排 + 砍到 ${budget} 条后（剩 ${picked.length} 条，图片 ${imgs.length} 条）：`)
  for (const h of picked) console.log('  ' + show(h))
  console.log(
    imgs.length
      ? `图片命中的 imageUrl 保住了：${imgs[0].imageUrl}`
      : '图片命中在最后这一步被文本块按分挤掉——和实测里 hits 一条图都没有一致',
  )
}

/**
 * 「要不要挂图」的门：纯函数，不加载任何模型。
 * 正反例都列出来，是要看清门的边界在哪——门开太松会逢问必挂图。
 *
 * 用法：漏挂了一句，先把那句原话加进来（期望 true），再改词表：
 * 门是「用户说了什么」的判定，只有真实漏掉的句子能当回归用例。
 */
const GATE_CASES: Array<[string, boolean]> = [
  // 2026-09-22 实测漏掉的那句：词表原来只有「给我图」，用户说的是「图给我」，顺序一反就没命中
  ['平台工作周报-2026年8月W1里面的图给我', true],
  ['周报里那张「平台渗透率」的图，把原图发我看看', true],
  ['发我张截图', true],
  ['这期周报的配图有吗', true],
  ['有图片吗', true],
  ['把图发我', true],
  ['W1 的图发我', true],
  ['把周报里的图贴出来', true],
  ['那张图呢', true],
  ['平台工程周报讲了什么', false],
  ['这个项目的架构图怎么画的', false], // 光一个「图」不算：多数是要文字说明
  ['RAG 的召回率是多少', false],
  ['帮我算一下 123*456', false],
  ['那张表里渗透率是多少', false],
  ['视图发布流程是怎样的', false], // 「视图发布」里藏着一个「图发」，不能只匹配这两个字
]

async function gateCase() {
  const { wantsImage } = await import('../src/retrieve.js')
  let bad = 0
  for (const [text, want] of GATE_CASES) {
    const got = wantsImage('', text) // 只判用户原话
    const ok = got === want
    if (!ok) bad += 1
    console.log(`  ${ok ? '✓' : '✗'}  ${want ? '该挂' : '不该挂'} | ${text}`)
  }
  console.log(bad ? `\n${bad} 条不符合预期` : '\n全部符合预期')
}

/**
 * 「正文自己引用的图」这条路能不能走通：全库扫一遍 md 图片链接，
 * 看有多少能映射回本地缓存的字节（URL → img_<sha256[:16]> → 磁盘文件）。
 *
 * 只用 index.json + 文件系统，不加载模型。映射不上的 URL 要能一眼看见，
 * 否则这条通道会静默变空——和当初 searchImages 静默返回 [] 是同一个坑。
 */
function contentCase() {
  const items = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')).items as Array<{
    id: string
    docId: string
    title: string
    text: string
  }>
  const MD_IMG = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g
  let chunksWithImg = 0
  let urls = 0
  let cached = 0
  const miss: string[] = []
  for (const c of items) {
    const found = [...String(c.text).matchAll(MD_IMG)]
    if (!found.length) continue
    chunksWithImg += 1
    for (const [, alt, url] of found) {
      urls += 1
      const id = `img_${imageCacheId(url)}`
      if (imageFileById(id)) {
        cached += 1
        if (id === 'img_3cb34c63e225b1d3' || id === 'img_840af4aba075876e') {
          console.log(`  ✓ ${c.id} 「${alt}」 → ${id}（就是 W1 那两张之一）`)
        }
      } else {
        miss.push(`${c.id} ${alt} ${url.slice(0, 60)}… → ${id}`)
      }
    }
  }
  console.log(`\n带图的块 ${chunksWithImg} 个，正文里共 ${urls} 个图片链接`)
  console.log(`能映射到本地字节的 ${cached} 个，映射不上 ${miss.length} 个`)
  for (const m of miss.slice(0, 10)) console.log(`  ✗ ${m}`)

  // 「内容依赖就带回」这一步的纯函数自检：拿 W1 那篇带图的两个块喂进去
  const w1 = items.filter((c) => c.docId === 'w_e62e19bff8aaacbb' && /!\[[^\]]*\]\(/.test(c.text))
  const asHits: SearchHit[] = w1.map((c, i) => ({
    id: c.id,
    docId: c.docId,
    title: c.title,
    text: c.text,
    citation: i + 1,
    score: 0,
  }))
  const attached = attachReferencedImages(asHits)
  console.log(`\nW1 那篇带图的块 ${asHits.length} 个 → 自动带回 ${attached.length} 张：`)
  for (const h of attached) console.log(`  ${h.title} → ${h.imageUrl}`)
}

async function main() {
  if (process.argv.includes('--gate')) {
    await gateCase()
    return
  }
  if (process.argv.includes('--content')) {
    contentCase()
    return
  }

  const items = loadItems()
  console.log(`图片库 ${items.length} 条（门槛 MIN_IMAGE_COSINE=${MIN_IMAGE_COSINE}）`)

  if (!(await tryLoadVlEmbedder())) {
    console.log(`CLIP 加载失败：${getVlEmbedError()}`)
    console.log('→ searchImages() 会静默返回 []，表现得像「库里没有图」')
    return
  }
  console.log('CLIP 加载成功')

  const queries = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const list = queries.length ? queries : DEFAULT_QUERIES

  if (process.argv.includes('--fusion')) {
    await fusionCase(list[0], items)
    return
  }

  for (const q of list) {
    const qv = await embedVlQuery(q)
    const scored = items
      .map((it) => ({ it, score: cosine(qv, it.embedding) }))
      .sort((a, b) => b.score - a.score)
    const passed = scored.filter((x) => x.score >= MIN_IMAGE_COSINE)
    console.log(`\n「${q}」 过线 ${passed.length}/${items.length} | 最高 ${scored[0].score.toFixed(3)}`)
    for (const x of scored.slice(0, 5)) {
      console.log(`  ${x.score.toFixed(3)}  ${x.it.id}  ${x.it.title}  (${x.it.docId})`)
    }
    // 用户实际问的那两张 W1 图排到第几：直接回答「为什么给不出来」
    for (const id of ['img_3cb34c63e225b1d3', 'img_840af4aba075876e']) {
      const rank = scored.findIndex((x) => x.it.id === id) + 1
      const hit = scored[rank - 1]
      console.log(`  W1 ${id} 第 ${rank} 名，余弦 ${hit.score.toFixed(3)}`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
