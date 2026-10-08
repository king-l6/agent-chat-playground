/**
 * 会话内的提问目录（聊天区右侧窄栏）：把这次会话里每条「你」的提问列成一行简略，
 * 点一下立刻定位到那条消息，不做滚动动画。
 *
 * 两条硬约定：
 * 1. 锚点是 MessageList 里 <article data-msg-id={m.id}>，改名要两边同步。
 * 2. 跳转前必须先让 App 关掉「自动贴底」（onJump 回调）——否则生成中的下一个
 *    text_delta 会把视图拽回底部，看起来就像「点了没跳过去」。这个顺序只有
 *    App 侧能做（stickBottom 在那里），所以这里只负责通知。
 */
import { useEffect, useMemo, useState } from 'react'
import type { UiMessage } from '../types'
import './ChatOutline.css'

/** 一行简略：压平空白、截断（超出部分靠 CSS 单行省略 + title 悬停看全文） */
function brief(text: string, max = 60) {
  const flat = text.trim().replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export function ChatOutline({
  messages,
  containerRef,
  onJump,
}: {
  messages: UiMessage[]
  /**
   * 滚动容器（App.tsx 的 main）：IntersectionObserver 的 root，也是跳转查找的范围。
   * 这里只声明 { current }，不引用 RefObject——React 18/19 的 RefObject 定义不同
   * （19 里 current 不可为 null），用结构类型两边都能传。
   */
  containerRef: { current: HTMLElement | null }
  /** 跳转前通知 App：把人翻到中间后不要再自动贴底 */
  onJump?: () => void
}) {
  const items = useMemo(
    () => messages.filter((m) => m.role === 'user' && m.content.trim()),
    [messages],
  )

  /*
   * 目录项的 id 序列。用它（而不是 items 数组本身）当观察器的依赖：
   * 流式回答时 messages 每帧都是新数组，但提问 id 没变，不该反复重建观察器。
   */
  const idKey = items.map((m) => m.id).join('|')

  const [activeId, setActiveId] = useState('')

  /*
   * 高亮「当前读到哪一条」：同时进视口的多条里取最靠前的那个。
   * 一条都没进视口时不清空（保留上一次的高亮），否则最后一条被长回答顶出屏幕后
   * 整个目录会看上去「什么都没选中」。
   */
  useEffect(() => {
    const root = containerRef.current
    if (!root || items.length === 0) return
    const tips = items
    const visible = new Set<string>()
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.msgId
          if (!id) continue
          if (entry.isIntersecting) visible.add(id)
          else visible.delete(id)
        }
        const first = tips.find((m) => visible.has(m.id))
        if (first) setActiveId(first.id)
      },
      { root, threshold: 0 },
    )
    for (const m of tips) {
      const node = root.querySelector(`[data-msg-id="${m.id}"]`)
      if (node) io.observe(node)
    }
    return () => io.disconnect()
  }, [idKey, containerRef])

  /**
   * 跳到某条提问：瞬时定位（不传 behavior，默认 'auto'，没有过场动画）。
   * 顺序很重要——先通知 App 关掉贴底，再滚。
   */
  function jump(id: string) {
    const node = containerRef.current?.querySelector(`[data-msg-id="${id}"]`)
    if (!node) return
    onJump?.()
    node.scrollIntoView({ block: 'start' })
    setActiveId(id)
  }

  // 只有一轮提问时目录没有意义，直接不占右侧这一栏（外层用的是 auto 列，会自动塌掉）
  if (items.length < 2) return null

  return (
    <aside className="outline" aria-label="提问目录">
      <p className="outline__title">提问目录</p>
      <ol className="outline__list">
        {items.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              className={m.id === activeId ? 'outline__item outline__item--on' : 'outline__item'}
              title={m.content.trim().replace(/\s+/g, ' ')}
              onClick={() => jump(m.id)}
            >
              <span className="outline__text">{brief(m.content)}</span>
            </button>
          </li>
        ))}
      </ol>
    </aside>
  )
}
