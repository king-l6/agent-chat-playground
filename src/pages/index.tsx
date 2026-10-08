/**
 * 应用外壳：只负责把页面组件挂上，不引任何额外运行时依赖，
 * 保证 tsc --noEmit 在未安装 next 依赖时也能通过。
 */
import type { ComponentType } from 'react'

export type BeautyAppProps = {
  Component: ComponentType<Record<string, unknown>>
  pageProps: Record<string, unknown>
}

export default function App({ Component, pageProps }: BeautyAppProps) {
  return <Component {...pageProps} />
}