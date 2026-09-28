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
