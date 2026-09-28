/**
 * 重新扫描索引：只重算内容变了的文档，没变的一篇都不碰。
 *
 *   npm run index:sync
 *
 * 可以挂 cron / launchd 定时跑（比如每小时一次），不需要开着 dev server。
 * 没扫描到变化就什么都不编码，直接退出。
 */
import { resyncIndex } from '../src/retrieve.js'

async function main() {
  const started = Date.now()
  const stats = await resyncIndex()
  if (stats.reindexed === 0 && stats.dropped === 0) {
    console.log(`[resync] ${stats.docs} 篇全部没变，无需重算（${stats.elapsedMs}ms）`)
  } else {
    console.log(
      `[resync] 文档 ${stats.docs} 篇：复用 ${stats.reused}，重算 ${stats.reindexed}（编码 ${stats.embedded} 块），移除 ${stats.dropped} 篇`,
    )
    for (const name of stats.changed) console.log(`[resync]   更新 ${name}`)
  }
  console.log(`[resync] 总用时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
}

main().catch((err) => {
  console.error('[resync] 失败:', err)
  process.exit(1)
})
