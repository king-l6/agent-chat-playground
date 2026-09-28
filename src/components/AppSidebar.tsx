type PageId = 'chat' | 'documents' | 'memory' | 'vectors' | 'canvas' | 'settings' | 'delivery' | 'video'

type NavItem = {
  id: PageId
  href: string
  label: string
  icon: 'chat' | 'doc' | 'memory' | 'agent' | 'vector' | 'ship' | 'gear' | 'film'
}

const PRIMARY: NavItem[] = [
  { id: 'chat', href: '#/', label: '会话', icon: 'chat' },
  { id: 'documents', href: '#/documents', label: '文档', icon: 'doc' },
  { id: 'memory', href: '#/memory', label: '记忆', icon: 'memory' },
  { id: 'canvas', href: '#/canvas', label: '智能体', icon: 'agent' },
  { id: 'delivery', href: '#/delivery', label: '发布', icon: 'ship' },
  { id: 'video', href: '#/video', label: '视频', icon: 'film' },
]

const HELP: NavItem[] = [
  { id: 'vectors', href: '#/vectors', label: '向量库', icon: 'vector' },
  { id: 'settings', href: '#/settings', label: '配置', icon: 'gear' },
]

function Icon({ name }: { name: NavItem['icon'] }) {
  const props = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  if (name === 'chat') {
    return (
      <svg {...props}>
        <path d="M12 5v14M5 12h14" />
      </svg>
    )
  }
  if (name === 'doc') {
    return (
      <svg {...props}>
        <path d="M7 3h7l5 5v13H7z" />
        <path d="M14 3v5h5M9 13h6M9 17h4" />
      </svg>
    )
  }
  if (name === 'memory') {
    // 两瓣的脑子轮廓，比「书签」更能一眼看出是记忆而不是收藏
    return (
      <svg {...props}>
        <path d="M12 7.5a3 3 0 0 0-6 0v9a2.5 2.5 0 0 0 5 1.2h1z" />
        <path d="M12 7.5a3 3 0 0 1 6 0v9a2.5 2.5 0 0 1-5 1.2h-1z" />
        <path d="M9 11h.01M15 11h.01M9.5 15h1.2M13.3 15h1.2" />
      </svg>
    )
  }
  if (name === 'agent') {
    return (
      <svg {...props}>
        <rect x="5" y="8" width="14" height="10" rx="2" />
        <path d="M12 8V5M9 13h.01M15 13h.01M9 18v2h6v-2" />
      </svg>
    )
  }
  if (name === 'vector') {
    return (
      <svg {...props}>
        <circle cx="7" cy="8" r="2.2" />
        <circle cx="17" cy="7" r="2.2" />
        <circle cx="12" cy="17" r="2.2" />
        <path d="M8.7 9.4 11 15.2M15.3 8.8 13 15.1" />
      </svg>
    )
  }
  if (name === 'ship') {
    return (
      <svg {...props}>
        <path d="M4 12h16l-2 6H6zM12 4v8M8 7h8" />
      </svg>
    )
  }
  if (name === 'film') {
    return (
      <svg {...props}>
        <rect x="3" y="6" width="18" height="12" rx="1.5" />
        <path d="M7 6v12M17 6v12M3 10h4M3 14h4M17 10h4M17 14h4" />
      </svg>
    )
  }
  return (
    <svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2M12 19v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M3 12h2M19 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  )
}

export function AppSidebar(props: {
  page: PageId
  collapsed: boolean
  mode: 'live' | 'mock' | 'unknown'
  model: string
  onToggle: () => void
}) {
  return (
    <aside className={props.collapsed ? 'rail rail--min' : 'rail'}>
      <div className="rail__brand">
        <span className="rail__logo">AgentOS</span>
        <button
          type="button"
          className="rail__fold"
          onClick={props.onToggle}
          title={props.collapsed ? '展开侧栏' : '收起侧栏'}
          aria-label={props.collapsed ? '展开侧栏' : '收起侧栏'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {props.collapsed ? <path d="M9 6l6 6-6 6" /> : <path d="M15 6l-6 6 6 6" />}
          </svg>
        </button>
      </div>

      <nav className="rail__nav" aria-label="主导航">
        {PRIMARY.map((item) => (
          <a
            key={item.id}
            href={item.href}
            className={props.page === item.id ? 'rail__item rail__item--on' : 'rail__item'}
            title={item.label}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </a>
        ))}
      </nav>

      <div className="rail__help">
        <p className="rail__help-label">帮助</p>
        {HELP.map((item) => (
          <a
            key={item.id}
            href={item.href}
            className={props.page === item.id ? 'rail__item rail__item--on' : 'rail__item'}
            title={item.label}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </a>
        ))}
      </div>

      <a className={`rail__badge rail__badge--${props.mode}`} href="#/settings" title="配置 API Key">
        {props.mode === 'live' && (props.model ? `LIVE · ${props.model}` : 'LIVE')}
        {props.mode === 'mock' && 'MOCK'}
        {props.mode === 'unknown' && '未连接'}
      </a>
    </aside>
  )
}
