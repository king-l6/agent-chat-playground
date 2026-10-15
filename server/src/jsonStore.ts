/**
 * JSON 落盘的两个小工具。
 *
 * 之前每个模块各写一份「readDisk + persist」，落盘全是裸 writeFileSync：
 * 写到一半进程挂掉就留下半截 JSON，下次启动整个文件读不出来。
 * 这里统一成 tmp + rename —— rename 在同一文件系统上是原子的，
 * 要么是旧内容，要么是新内容，不会出现中间态。
 *
 * 注意：tmp 必须和目标**同目录**。放到 /tmp 再 rename 会跨设备，直接抛 EXDEV。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 读 JSON；不存在或坏了都返回 null（调用方自己决定是报错还是当空） */
export function readJsonFile<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** 原子写 JSON：先写同目录的 .tmp，再 rename 覆盖 */
export function writeJsonAtomic(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(body))
  fs.renameSync(tmp, file)
}

/** 名字形如 `index.json.15306.tmp` —— 带 pid 的那种漏出来的临时文件 */
const PID_TMP = /\.\d+\.tmp$/

/** 认定「肯定没人还在写」的年龄。见下面 old-enough 那段说明。 */
const STALE_TMP_MS = 10 * 60_000

/**
 * 清掉上次非正常退出留下的 `.<pid>.tmp`。
 *
 * 为什么不靠命名去重收敛：retrieve.ts / imageIndex.ts 的临时名里带 pid，
 * 每个进程一份，进程被 SIGKILL（tsx watch 重启、容器被 kill）时 catch 不执行，
 * 文件就留下了。实测在同一个 index.json 上跑几个 tsx watch，一天能攒出几十个。
 *
 * 两道自我约束，因为这是在一个名为 data 的目录里「按名字删文件」：
 *   1) 只删 `<名字>.<纯数字>.tmp` 这个形状，目录里任何别的文件都不碰；
 *      这样 writeJsonAtomic 的 `<file>.tmp`（写坏的那一份）也不会被误伤 ——
 *      它每个文件最多一份，下次写就覆盖了，不是泄漏。
 *   2) 只删**够老**的。不能按「pid 还活着就跳过」判：宿主机上多进程并发写同一个
 *      索引是常态，把一个正在写的 tmp 删掉会让对方的 rename 失败。
 *      10 分钟远超一次索引落盘，够老 = 写它的那个进程已经不在了。
 *
 * 返回删掉的个数。任何一步失败都不抛：这是打扫卫生，不能因为扫不动就不让服务起。
 */
export function sweepStaleTmp(dir: string): number {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  const cutoff = Date.now() - STALE_TMP_MS
  let removed = 0
  for (const name of names) {
    if (!PID_TMP.test(name)) continue
    const file = path.join(dir, name)
    try {
      if (fs.statSync(file).mtimeMs > cutoff) continue
      fs.unlinkSync(file)
      removed += 1
    } catch {
      /* 删不动就算了 */
    }
  }
  return removed
}

/** 追加一行 jsonl（记忆日志用）；同样先建目录 */
export function appendJsonl(file: string, row: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`)
}

/** 读 jsonl；坏行跳过而不是整文件失败 */
export function readJsonl<T>(file: string, limit = 200): T[] {
  try {
    if (!fs.existsSync(file)) return []
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    const tail = lines.slice(-limit)
    const rows: T[] = []
    for (const line of tail) {
      try {
        rows.push(JSON.parse(line) as T)
      } catch {
        // 半截行（上次写到一半崩了）就跳过
      }
    }
    return rows
  } catch {
    return []
  }
}
