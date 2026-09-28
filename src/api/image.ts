import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  BEAUTY_STYLE_FALLBACK,
  BeautyImageRequestError,
  fetchBeautyStyles,
  generateBeautyImage,
  type BeautyImageItem,
  type BeautyStyleOption,
} from './api/image'

const GENERATE_TIMEOUT_MS = 60000

const DEFAULT_STYLE: BeautyStyleOption =
  BEAUTY_STYLE_FALLBACK[0] ?? { id: 'portrait', name: '质感写真', description: '', tags: [] }

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 90,
  overflowY: 'auto',
  background: 'linear-gradient(160deg, #0e1016 0%, #161a24 58%, #0b0d12 100%)',
  color: '#e9edf6',
}

const containerStyle: CSSProperties = { maxWidth: 1040, margin: '0 auto', padding: '28px 20px 72px' }

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 16,
  marginBottom: 20,
}

const titleStyle: CSSProperties = { margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: 0.5 }

const subtitleStyle: CSSProperties = { margin: '8px 0 0', fontSize: 13, color: '#9aa4b8', lineHeight: 1.6 }

const backStyle: CSSProperties = {
  flex: '0 0 auto',
  padding: '8px 14px',
  borderRadius: 8,
  border: '1px solid #2b3446',
  color: '#cdd6e6',
  fontSize: 13,
  textDecoration: 'none',
}

const panelStyle: CSSProperties = {
  background: 'rgba(20, 24, 34, 0.86)',
  border: '1px solid #232b3a',
  borderRadius: 14,
  padding: '18px 18px 20px',
  marginBottom: 18,
}

const sectionLabelStyle: CSSProperties = { fontSize: 13, color: '#8f9ab0', marginBottom: 12 }

const styleGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
  gap: 10,
  marginBottom: 20,
}

const styleCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 6,
  padding: '12px 14px',
  borderRadius: 10,
  border: '1px solid #2a3346',
  background: '#171c27',
  color: '#dfe6f3',
  cursor: 'pointer',
  textAlign: 'left',
}

const styleCardActiveStyle: CSSProperties = {
  borderColor: '#6f7cff',
  background: 'rgba(111, 124, 255, 0.16)',
  boxShadow: '0 0 0 1px rgba(111, 124, 255, 0.35) inset',
}

const styleNameStyle: CSSProperties = { fontSize: 14, fontWeight: 600 }

const styleDescStyle: CSSProperties = { fontSize: 12, color: '#94a0b6', lineHeight: 1.5 }

const textareaStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  minHeight: 78,
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid #2a3346',
  background: '#11151f',
  color: '#e9edf6',
  fontSize: 14,
  lineHeight: 1.6,
  resize: 'vertical',
}

const actionRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 12,
  marginTop: 16,
}

const primaryButtonStyle: CSSProperties = {
  padding: '10px 22px',
  borderRadius: 10,
  border: '1px solid #6f7cff',
  background: 'linear-gradient(135deg, #6f7cff, #9b6bff)',
  color: '#ffffff',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
}

const primaryButtonDisabledStyle: CSSProperties = { opacity: 0.65, cursor: 'progress' }

const ghostButtonStyle: CSSProperties = {
  padding: '10px 18px',
  borderRadius: 10,
  border: '1px solid #2b3446',
  background: 'transparent',
  color: '#cdd6e6',
  fontSize: 13,
  cursor: 'pointer',
}

const hintStyle: CSSProperties = { fontSize: 12, color: '#7b8698' }

const errorStyle: CSSProperties = {
  marginTop: 14,
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid #7a2b3a',
  background: 'rgba(122, 43, 58, 0.22)',
  color: '#ffbcc7',
  fontSize: 13,
  lineHeight: 1.6,
}

const noticeStyle: CSSProperties = {
  marginTop: 14,
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid #2b4a3d',
  background: 'rgba(43, 122, 88, 0.16)',
  color: '#a9e6c9',
  fontSize: 13,
}

const resultGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
  gap: 14,
}

const figureStyle: CSSProperties = {
  margin: 0,
  border: '1px solid #232b3a',
  borderRadius: 12,
  overflow: 'hidden',
  background: '#11151f',
}

const imageStyle: CSSProperties = { display: 'block', width: '100%', height: 'auto' }

const captionStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  padding: '10px 12px',
  fontSize: 13,
  color: '#cdd6e6',
}

const downloadStyle: CSSProperties = {
  color: '#8fb8ff',
  fontSize: 13,
  textDecoration: 'none',
  border: '1px solid #2b3446',
  borderRadius: 8,
  padding: '4px 10px',
}

const emptyStyle: CSSProperties = {
  padding: '26px 12px',
  textAlign: 'center',
  fontSize: 13,
  color: '#7b8698',
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError'
}

export default function BeautyImagePage() {
  const [styles, setStyles] = useState<BeautyStyleOption[]>(BEAUTY_STYLE_FALLBACK)
  const [styleId, setStyleId] = useState<string>(DEFAULT_STYLE.id)
  const [prompt, setPrompt] = useState('')
  const [images, setImages] = useState<BeautyImageItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    fetchBeautyStyles(controller.signal).then((list) => {
      if (!alive || list.length === 0) return
      const first = list[0]
      if (!first) return
      setStyles(list)
      setStyleId((current) => (list.some((item) => item.id === current) ? current : first.id))
    })
    return () => {
      alive = false
      controller.abort()
    }
  }, [])

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  useEffect(
    () => () => {
      abortRef.current?.abort()
    },
    [],
  )

  const activeStyle = useMemo(
    () => styles.find((item) => item.id === styleId) ?? styles[0],
    [styles, styleId],
  )

  const handleGenerate = useCallback(async () => {
    if (loading) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const timer = window.setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS)
    const startedAt = Date.now()

    setLoading(true)
    setError('')
    setNotice('')

    try {
      const result = await generateBeautyImage({ prompt, style: styleId }, { signal: controller.signal })
      const list = result.images
      setImages(list)
      if (list.length === 0) {
        setError('生成结果为空，请稍后重试')
      } else {
        const name = result.styleName || activeStyle?.name || '默认风格'
        const used = ((Date.now() - startedAt) / 1000).toFixed(1)
        setNotice(`已按「${name}」生成 ${list.length} 张图片，用时 ${used} 秒`)
      }
    } catch (err) {
      setImages([])
      if (isAbortError(err)) {
        setError('生成超时（超过 60 秒），请检查网络后重试')
      } else if (err instanceof BeautyImageRequestError) {
        setError(err.message)
      } else {
        setError('图片生成失败，请稍后重试')
      }
    } finally {
      window.clearTimeout(timer)
      abortRef.current = null
      setLoading(false)
    }
  }, [activeStyle, loading, prompt, styleId])

  const handleClear = useCallback(() => {
    setImages([])
    setError('')
    setNotice('')
  }, [])

  return (
    <div style={overlayStyle} data-testid="beauty-image-page">
      <div style={containerStyle}>
        <header style={headerStyle}>
          <div>
            <h2 style={titleStyle}>一键生成美女图片</h2>
            <p style={subtitleStyle}>不用写复杂提示词：选一个风格，点「一键生成」就能出图，并可直接下载保存。</p>
          </div>
          <a href="#/" style={backStyle}>
            返回对话
          </a>
        </header>

        <section style={panelStyle}>
          <div style={sectionLabelStyle}>1. 选择风格预设</div>
          <div style={styleGridStyle}>
            {styles.map((item) => {
              const active = item.id === styleId
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setStyleId(item.id)}
                  style={active ? { ...styleCardStyle, ...styleCardActiveStyle } : styleCardStyle}
                >
                  <span style={styleNameStyle}>{item.name}</span>
                  <span style={styleDescStyle}>{item.description}</span>
                </button>
              )
            })}
          </div>

          <div style={sectionLabelStyle}>2. 补充描述（可选，留空即用内置提示词）</div>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="例如：傍晚的海边，微风吹动长发"
            rows={3}
            maxLength={200}
            style={textareaStyle}
          />

          <div style={actionRowStyle}>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={loading}
              style={loading ? { ...primaryButtonStyle, ...primaryButtonDisabledStyle } : primaryButtonStyle}
            >
              {loading ? '生成中…' : '一键生成'}
            </button>
            <button
              type="button"
              onClick={handleClear}
              disabled={loading || images.length === 0}
              style={ghostButtonStyle}
            >
              清空结果
            </button>
            <span style={hintStyle}>提示：违规、擦边或指定真实人物的内容会被安全校验拦截，不会产出图片。</span>
          </div>

          {error ? (
            <div style={errorStyle} role="alert">
              {error}
            </div>
          ) : null}
          {!error && notice ? <div style={noticeStyle}>{notice}</div> : null}
        </section>

        <section style={panelStyle}>
          <div style={sectionLabelStyle}>3. 生成结果</div>
          {loading ? <div style={emptyStyle}>正在生成图片，请稍候…</div> : null}
          {!loading && images.length === 0 ? (
            <div style={emptyStyle}>还没有图片，点击「一键生成」开始。</div>
          ) : null}
          <div style={resultGridStyle}>
            {images.map((item) => (
              <figure key={item.id} style={figureStyle}>
                <img
                  src={item.dataUrl || item.url}
                  alt={`${item.styleName} 生成结果`}
                  style={imageStyle}
                  onError={(event) => {
                    const node = event.currentTarget
                    if (node.dataset.fallback !== '1' && item.url) {
                      node.dataset.fallback = '1'
                      node.src = item.url
                    }
                  }}
                />
                <figcaption style={captionStyle}>
                  <span>{item.styleName}</span>
                  <a href={item.dataUrl || item.url} download={`beauty-${item.id}.svg`} style={downloadStyle}>
                    下载
                  </a>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}