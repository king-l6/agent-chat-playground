/**
 * 生成结果的展示画廊：网格列出图片，每张可打开 / 下载；空态与「生成中」有提示。
 *
 * 本文件此前是「一键生成美女图片」的另一份页面实现（导出的组件叫 BeautyGenerator），
 * 里面引用了两个并不存在的模块（`../lib/styles`、`../lib/imageStore`），
 * 最后还 `import { ResultGallery } from './ResultGallery'` —— 自己 import 自己，
 * 而本文件从未导出过 ResultGallery。因为 tsconfig.app.json 的 include 是 ["src"]，
 * 这几个 import 会让 `npm run typecheck` / `npm run build` 直接失败。
 *
 * 同一功能的完整实现已在别处：接口层 `src/api/image.ts` + 页面
 * `src/components/BeautyImagePage.tsx`（已接后端 `/api/image/*`，但尚未接入
 * App.tsx 的 hash 路由）。那份重复实现就地清掉，这里只留一个自洽、
 * 除 react 类型外零依赖的展示组件。
 *
 * 现状：**当前没有调用方** —— BeautyImagePage 自己渲染结果网格。
 * 要在页面上复用它，把那段网格换成：
 *   <ResultGallery images={images} loading={loading} />
 * props 形状见下面的 ResultGalleryItem。
 */
import type { CSSProperties } from 'react'

export type ResultGalleryItem = {
  id: string
  /** 图片地址；dataUrl（内联图）存在时优先用它 */
  url: string
  /** 内联图 data: URL，可省 */
  dataUrl?: string
  /** 卡片角标文案，一般是风格名 */
  styleName?: string
  width?: number
  height?: number
}

export type ResultGalleryProps = {
  images: ResultGalleryItem[]
  /** 生成中：没有图时显示「正在生成」而不是空态 */
  loading?: boolean
  /** 下载文件名前缀，最终名字是 `${downloadPrefix}-${id}` */
  downloadPrefix?: string
  /** 覆盖外层容器样式（各页面配色不同，这里不写死主题色） */
  style?: CSSProperties
}

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
  gap: 14,
}

const figureStyle: CSSProperties = {
  margin: 0,
  border: '1px solid rgba(148, 163, 184, 0.35)',
  borderRadius: 12,
  overflow: 'hidden',
}

const imageStyle: CSSProperties = { display: 'block', width: '100%', height: 'auto' }

const captionStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  padding: '10px 12px',
  fontSize: 13,
}

const downloadStyle: CSSProperties = {
  fontSize: 13,
  textDecoration: 'none',
  border: '1px solid rgba(148, 163, 184, 0.45)',
  borderRadius: 8,
  padding: '4px 10px',
}

const emptyStyle: CSSProperties = {
  padding: '26px 12px',
  textAlign: 'center',
  fontSize: 13,
  opacity: 0.7,
}

/** 尺寸有就带出来，没有就不提（后端 mock 也可能不给） */
function captionOf(item: ResultGalleryItem): string {
  const parts: string[] = []
  if (item.styleName) parts.push(item.styleName)
  if (item.width != null && item.height != null) parts.push(`${item.width}×${item.height}`)
  return parts.join(' · ')
}

export function ResultGallery({
  images,
  loading = false,
  downloadPrefix = 'image',
  style,
}: ResultGalleryProps) {
  if (images.length === 0) {
    return (
      <div style={{ ...emptyStyle, ...style }}>
        {loading ? '正在生成图片，请稍候…' : '还没有图片，点击「一键生成」开始。'}
      </div>
    )
  }

  return (
    <div style={{ ...gridStyle, ...style }}>
      {images.map((item) => {
        const src = item.dataUrl || item.url
        return (
          <figure key={item.id} style={figureStyle}>
            <img
              src={src}
              alt={item.styleName ? `${item.styleName} 生成结果` : '生成结果'}
              style={imageStyle}
              /* dataUrl 渲染失败时退回 url；再失败就保持原样，别来回抖 */
              onError={(event) => {
                const node = event.currentTarget
                if (node.dataset.fallback !== '1' && item.url && item.url !== src) {
                  node.dataset.fallback = '1'
                  node.src = item.url
                }
              }}
            />
            <figcaption style={captionStyle}>
              <span>{captionOf(item)}</span>
              <a href={src} download={`${downloadPrefix}-${item.id}`} style={downloadStyle}>
                下载
              </a>
            </figcaption>
          </figure>
        )
      })}
    </div>
  )
}

export default ResultGallery
