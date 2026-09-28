/**
 * 后端地址。与 src/api/*.ts 的约定一致：dev 下为空（相对路径走 vite 代理到 8790），
 * 打包时由 VITE_API_BASE 指到 http://127.0.0.1:8790。
 */
export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

/**
 * 把后端给的站内相对地址（/api/...）补成真正取得到的 URL，其它地址原样返回。
 *
 * 打包后的页面是从 file:// 加载的，正文里写 `<img src="/api/...">` 会被浏览器
 * 解析成 `file:///api/...`——必然裂图。api 请求有 axios 加前缀，图片没有，
 * 所以图片这边得自己补一次。
 *
 * 只管 `/api/` 前缀：wiki 正文里的 `https://wdcdn...` 是绝对地址，`./x.png`
 * 这类相对资源也不该被改写。规则越窄越不容易误伤。
 */
export function apiUrl(src: string): string {
  if (!src) return src
  if (/^(https?:|data:|blob:)/i.test(src)) return src
  return src.startsWith('/api/') ? `${API_BASE}${src}` : src
}
