import dotenv from 'dotenv'
import path from 'node:path'
dotenv.config({ path: path.resolve('.', '.env'), override: true })
import { COMPANY_CASES } from '../src/eval-cases.ts'
import { loadIndexedItems, searchVectors, searchHybrid, searchRerank } from '../src/retrieve.ts'

async function main() {
  const fails = [
    'wiki-push-nyx',
    'wiki-pegasus-refresh',
    'wiki-bus',
    'wiki-timeout',
    'wiki-push-release',
    'wiki-agentos',
    'wiki-ann-gpu',
    'wiki-search-as',
  ]
  const items = await loadIndexedItems()
  const topK = 10
  for (const id of fails) {
    const c = COMPANY_CASES.find((x) => x.id === id)
    if (!c) continue
    console.log('\n====', c.id)
    console.log('Q:', c.query)
    console.log('expect', c.docId)
    // show how many chunks and sample titles for expect doc
    const mine = items.filter((it) => it.docId === c.docId)
    console.log('chunks', mine.length, 'titles', [...new Set(mine.map((m) => m.title))].slice(0, 8))
    for (const [name, fn] of [
      ['vec', searchVectors],
      ['hyb', searchHybrid],
      ['rr', searchRerank],
    ] as const) {
      const hits = await fn(c.query, items, topK)
      const line = hits
        .map((h, i) => {
          const ok = h.docId === c.docId ? '✓' : ' '
          return `${i + 1}${ok} ${h.title.slice(0, 36)}`
        })
        .join(' | ')
      console.log(name, line)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
