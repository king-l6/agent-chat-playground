/**
 * 向量落盘编码：base64 的 float32。
 *
 * 直接用 JSON 数字数组存向量的两个代价：
 *   1. 体积：一个 float 文本要 10 个字符上下，512 维就是 5.6KB；base64 只要 2.7KB
 *   2. 解析：JSON.parse 要逐字符解析近千万个浮点数，base64 一次解码就够
 * float32 只有 24 位尾数，但对余弦检索绰绰有余——各家向量库落盘也都是 float32 / base64。
 */
export const VECTOR_ENCODING = 'f32base64'

export function encodeVector(embedding: number[]): string {
  const f32 = Float32Array.from(embedding)
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64')
}

export function decodeVector(encoded: string): number[] {
  const buf = Buffer.from(encoded, 'base64')
  // slice 出一份 4 字节对齐的副本：Buffer 底层 ArrayBuffer 的起点不保证对齐，
  // 直接拿它建 Float32Array 视图会抛 RangeError
  const aligned = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return Array.from(new Float32Array(aligned))
}
