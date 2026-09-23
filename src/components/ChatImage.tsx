/**
 * 聊天里的图片。
 *
 * 模型贴出来的原图走本地直出接口（`/api/image/cache/<id>`），是站内相对地址：
 * dev 下 vite 代理能兜住，打包后从 file:// 加载的页面就必裂，所以统一过一道 apiUrl。
 *
 * 加载失败不留一个裂图图标——明说「这里本该有张图、但没取到」，比破图标可读。
 */
import { useState } from 'react'
import { apiUrl } from '../lib/apiUrl'

/**
 * 给 ReactMarkdown 的 img 用：`components={{ img: ChatImage }}`。
 * 用户气泡和助手气泡共用这一个（src/alt 的签名就是 img 渲染器要的形状，不必再包一层）。
 */
export function ChatImage({ src, alt }: { src?: string; alt?: string }) {
  const [failed, setFailed] = useState(false)
  const url = apiUrl(src ?? '')

  if (!url || failed) {
    return <span className="msg__img-fallback">图片未能加载{alt ? `：${alt}` : ''}</span>
  }

  return (
    <img
      className="msg__img"
      src={url}
      alt={alt ?? ''}
      loading="lazy"
      // 企微 CDN 实测不校验 Referer，但站内的图没必要把来源泄出去
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}

