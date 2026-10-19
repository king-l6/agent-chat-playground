/**
 * 盯会议室：选定日期和时间，每 30 秒查一次。
 * 目标时段有整段空闲的会议室，就订容量最小的那间，然后停。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { bookMeeting, scanMeeting, type MeetingRoom, type MeetingScan } from '../api/meeting'
import './MeetingPage.css'

const COOKIE_KEY = 'agentos.meeting.cookie'
const FORM_KEY = 'agentos.meeting.form'
const POLL_SEC = 30
const BAR_FROM = 8 * 2
const BAR_TO = 22 * 2

const REMINDERS: { value: number; label: string }[] = [
  { value: 2, label: '提前 15 分钟' },
  { value: 1, label: '准时' },
  { value: 3, label: '提前 30 分钟' },
  { value: 4, label: '提前 1 小时' },
  { value: 5, label: '提前 2 小时' },
  { value: 6, label: '提前 1 天' },
  { value: 0, label: '不提醒' },
]

const DEFAULT_SITE = '国正中心'

type FormState = {
  date: string
  start: string
  end: string
  subject: string
  /** 工区，对应地点第一段，例如国正中心。空字符串表示全部工区 */
  site: string
  name: string
  minCapacity: string
  reminderTime: number
}

type LogLine = { id: number; time: string; text: string; tone: 'info' | 'ok' | 'bad' }

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function clockOptions(fromMin: number, toMin: number): string[] {
  const out: string[] = []
  for (let m = fromMin; m <= toMin; m += 30) {
    out.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`)
  }
  return out
}

const STARTS = clockOptions(0, 23 * 60)
const ENDS = clockOptions(30, 23 * 60 + 30)

function defaultForm(): FormState {
  return {
    date: today(),
    start: '19:00',
    end: '20:30',
    subject: '1',
    site: DEFAULT_SITE,
    name: '',
    minCapacity: '',
    reminderTime: 2,
  }
}

function readForm(): FormState {
  const base = defaultForm()
  try {
    const raw = JSON.parse(localStorage.getItem(FORM_KEY) || '') as Partial<FormState>
    return {
      ...base,
      date: typeof raw.date === 'string' && raw.date ? raw.date : base.date,
      start: STARTS.includes(String(raw.start)) ? String(raw.start) : base.start,
      end: ENDS.includes(String(raw.end)) ? String(raw.end) : base.end,
      subject: typeof raw.subject === 'string' && raw.subject.trim() ? raw.subject : '1',
      site: typeof raw.site === 'string' ? raw.site : DEFAULT_SITE,
      name: typeof raw.name === 'string' ? raw.name : '',
      minCapacity: typeof raw.minCapacity === 'string' ? raw.minCapacity : '',
      reminderTime: REMINDERS.some((item) => item.value === raw.reminderTime)
        ? Number(raw.reminderTime)
        : 2,
    }
  } catch {
    return base
  }
}

function stamp(date: string, hm: string): string {
  return `${date} ${hm}:00`
}

function slotIndex(hm: string): number {
  const [h, m] = hm.split(':').map(Number)
  return (h * 60 + m) / 30
}

function rangeError(form: FormState): string {
  if (!form.date) return '先选日期'
  if (form.start >= form.end) return '结束时间要晚于开始时间'
  return ''
}

function parkOf(location: string): string {
  return location.split('/')[0]?.trim() || ''
}

function matches(room: MeetingRoom, form: FormState): boolean {
  const min = Number(form.minCapacity)
  if (form.minCapacity.trim() && Number.isFinite(min) && room.capacity < min) return false
  if (form.site && parkOf(room.location) !== form.site) return false
  if (form.name.trim() && !room.roomName.includes(form.name.trim())) return false
  return true
}

function windowFree(room: MeetingRoom, start: string, end: string): boolean {
  if (room.notReserve) return false
  if (room.busy.length < 48) return false
  if (start < room.reservableStart || end > room.reservableEnd) return false
  const a = slotIndex(start)
  const b = slotIndex(end)
  for (let i = a; i < b; i += 1) {
    if (room.busy[i] !== '0') return false
  }
  return true
}

function holders(room: MeetingRoom, start: string, end: string): string[] {
  const a = slotIndex(start)
  const b = slotIndex(end)
  const names = new Set<string>()
  for (let i = a; i < b; i += 1) {
    const name = room.who[String(i)]
    if (name) names.add(name)
  }
  return [...names]
}

function pickRoom(rooms: MeetingRoom[], form: FormState): MeetingRoom | null {
  const free = rooms.filter((room) => matches(room, form) && windowFree(room, form.start, form.end))
  free.sort((a, b) => {
    if (a.needApprove !== b.needApprove) return a.needApprove ? 1 : -1
    if (a.capacity !== b.capacity) return a.capacity - b.capacity
    return a.roomName.localeCompare(b.roomName, 'zh')
  })
  return free[0] ?? null
}

function nowText(): string {
  const d = new Date()
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

let logSeq = 0

export function MeetingPage() {
  const [cookie, setCookie] = useState(() => localStorage.getItem(COOKIE_KEY) || '')
  const [cookieOpen, setCookieOpen] = useState(() => !localStorage.getItem(COOKIE_KEY))
  const [form, setForm] = useState<FormState>(readForm)
  const [scan, setScan] = useState<MeetingScan | null>(null)
  const [watching, setWatching] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [busy, setBusy] = useState<'scan' | 'book' | ''>('')
  const [showBusyRooms, setShowBusyRooms] = useState(false)
  const [logs, setLogs] = useState<LogLine[]>([])
  const [booked, setBooked] = useState('')
  const watchingRef = useRef(false)
  const bookingRef = useRef(false)
  /** 停掉或 StrictMode 重跑时作废进行中的那一轮，避免同一空位订两次 */
  const loopToken = useRef(0)
  const formRef = useRef(form)
  const cookieRef = useRef(cookie)
  formRef.current = form
  cookieRef.current = cookie

  useEffect(() => {
    localStorage.setItem(FORM_KEY, JSON.stringify(form))
  }, [form])

  function pushLog(text: string, tone: LogLine['tone'] = 'info') {
    setLogs((prev) => [{ id: ++logSeq, time: nowText(), text, tone }, ...prev].slice(0, 30))
  }

  function patch<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function saveCookie(next: string) {
    const value = next.trim()
    setCookie(next)
    if (value) localStorage.setItem(COOKIE_KEY, value)
    else localStorage.removeItem(COOKIE_KEY)
  }

  async function runOnce(autoBook: boolean, token?: number) {
    const current = formRef.current
    const currentCookie = cookieRef.current.trim()
    const problem = rangeError(current)
    if (!currentCookie) {
      pushLog('先粘贴登录 Cookie', 'bad')
      watchingRef.current = false
      setWatching(false)
      return
    }
    if (problem) {
      pushLog(problem, 'bad')
      return
    }
    setBusy('scan')
    let result: MeetingScan
    try {
      result = await scanMeeting(currentCookie, current.date)
    } catch (err) {
      setBusy('')
      pushLog(err instanceof Error ? err.message : '查询失败', 'bad')
      return
    }
    setScan(result)
    const target = pickRoom(result.rooms, current)
    const scoped = result.rooms.filter((room) => matches(room, current))
    const freeCount = scoped.filter((room) => windowFree(room, current.start, current.end)).length
    const who = result.userName ? `（${result.userName}）` : ''
    const siteLabel = current.site || '全部工区'
    pushLog(
      `${siteLabel}${who}：${scoped.length} 间里，${current.start}–${current.end} 空闲 ${freeCount} 间`,
      freeCount > 0 ? 'ok' : 'info',
    )
    if (!autoBook || !watchingRef.current || (token != null && loopToken.current !== token)) {
      setBusy('')
      return
    }
    if (!target) {
      setBusy('')
      return
    }
    if (!current.subject.trim()) {
      setBusy('')
      pushLog('有空位，但还没写会议主题，所以没下单', 'bad')
      watchingRef.current = false
      setWatching(false)
      return
    }
    if (bookingRef.current) {
      setBusy('')
      return
    }
    if (token != null && loopToken.current !== token) {
      setBusy('')
      return
    }
    bookingRef.current = true
    setBusy('book')
    const approve = target.needApprove ? '，这间需要审批' : ''
    pushLog(`正在订 ${target.roomName}（${target.capacity} 人）${approve}`, 'info')
    try {
      const bookedResult = await bookMeeting({
        cookie: currentCookie,
        roomId: target.roomId,
        start: stamp(current.date, current.start),
        end: stamp(current.date, current.end),
        subject: current.subject.trim(),
        reminderTime: current.reminderTime,
      })
      const line = `${bookedResult.message}：${current.date} ${current.start}–${current.end} ${target.roomName}`
      setBooked(line)
      pushLog(line, 'ok')
      watchingRef.current = false
      setWatching(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : '预定失败'
      pushLog(message, 'bad')
      if (message.includes('允许 Apple 事件')) {
        watchingRef.current = false
        setWatching(false)
      }
    } finally {
      bookingRef.current = false
      setBusy('')
    }
  }

  const runRef = useRef(runOnce)
  runRef.current = runOnce

  useEffect(() => {
    if (!watching) return
    const token = ++loopToken.current
    let cancel = false
    let interval = 0
    const loop = async () => {
      await runRef.current(true, token)
      if (cancel || loopToken.current !== token || !watchingRef.current) return
      let left = POLL_SEC
      setCountdown(left)
      await new Promise<void>((resolve) => {
        interval = window.setInterval(() => {
          if (cancel || loopToken.current !== token || !watchingRef.current) {
            window.clearInterval(interval)
            resolve()
            return
          }
          left -= 1
          setCountdown(left)
          if (left <= 0) {
            window.clearInterval(interval)
            resolve()
          }
        }, 1000)
      })
      if (!cancel && loopToken.current === token && watchingRef.current) void loop()
    }
    void loop()
    return () => {
      cancel = true
      if (loopToken.current === token) loopToken.current += 1
      window.clearInterval(interval)
    }
  }, [watching])

  const filtered = useMemo(() => {
    const rooms = (scan?.rooms ?? []).filter((room) => matches(room, form))
    const free: MeetingRoom[] = []
    const taken: MeetingRoom[] = []
    for (const room of rooms) {
      if (windowFree(room, form.start, form.end)) free.push(room)
      else taken.push(room)
    }
    free.sort((a, b) => a.capacity - b.capacity || a.roomName.localeCompare(b.roomName, 'zh'))
    return { free, taken }
  }, [scan, form])

  const invalid = rangeError(form)
  const canWatch = Boolean(cookie.trim() && form.subject.trim() && !invalid)
  const sites = useMemo(() => {
    const names = new Set<string>([DEFAULT_SITE])
    if (form.site) names.add(form.site)
    for (const room of scan?.rooms ?? []) {
      const park = parkOf(room.location)
      if (park) names.add(park)
    }
    return [...names].sort((a, b) => {
      if (a === DEFAULT_SITE) return -1
      if (b === DEFAULT_SITE) return 1
      return a.localeCompare(b, 'zh')
    })
  }, [scan, form.site])

  function startWatch() {
    if (!canWatch || watching) return
    setBooked('')
    watchingRef.current = true
    setWatching(true)
    pushLog(`开始盯 ${form.site || '全部工区'} ${form.date} ${form.start}–${form.end}，每 ${POLL_SEC} 秒查一次`, 'info')
  }

  function stopWatch() {
    watchingRef.current = false
    setWatching(false)
    setCountdown(0)
    pushLog('已停止', 'info')
  }

  return (
    <div className="meet">
      <header className="meet__head">
        <div>
          <h1>会议室</h1>
          <p>选定工区、日期和时间。开始后每 30 秒查一次，只在所选工区里找整段空闲的会议室，订到容量最小的那间就停。</p>
        </div>
        <div className={watching ? 'meet__pill meet__pill--on' : 'meet__pill'}>
          {watching ? (busy === 'book' ? '正在下单' : busy === 'scan' ? '正在查询' : `${countdown}s 后复查`) : '未开始'}
        </div>
      </header>

      <div className="meet__layout">
        <form
          className="meet__form"
          onSubmit={(event) => {
            event.preventDefault()
            if (watching) stopWatch()
            else startWatch()
          }}
        >
          <label className="meet__field">
            <span>登录 Cookie</span>
            {cookieOpen ? (
              <textarea
                value={cookie}
                rows={4}
                spellCheck={false}
                placeholder="从会议室页面的请求头里复制 Cookie"
                onChange={(event) => saveCookie(event.target.value)}
              />
            ) : (
              <button type="button" className="meet__ghost" onClick={() => setCookieOpen(true)}>
                已保存在本机 · 更换
              </button>
            )}
          </label>

          <div className="meet__row">
            <label className="meet__field">
              <span>日期</span>
              <input type="date" value={form.date} onChange={(event) => patch('date', event.target.value)} />
            </label>
            <label className="meet__field">
              <span>开始</span>
              <select value={form.start} onChange={(event) => patch('start', event.target.value)}>
                {STARTS.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <label className="meet__field">
              <span>结束</span>
              <select value={form.end} onChange={(event) => patch('end', event.target.value)}>
                {ENDS.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="meet__field">
            <span>会议主题</span>
            <input
              value={form.subject}
              maxLength={80}
              placeholder="订到空位时用这个主题下单"
              onChange={(event) => patch('subject', event.target.value)}
            />
          </label>

          <div className="meet__row">
            <label className="meet__field">
              <span>工区</span>
              <select value={form.site} onChange={(event) => patch('site', event.target.value)}>
                {sites.map((site) => (
                  <option key={site} value={site}>
                    {site}
                  </option>
                ))}
                <option value="">全部工区</option>
              </select>
            </label>
            <label className="meet__field">
              <span>名称包含</span>
              <input
                value={form.name}
                placeholder="不填则任意空闲会议室"
                onChange={(event) => patch('name', event.target.value)}
              />
            </label>
            <label className="meet__field">
              <span>至少几人</span>
              <input
                inputMode="numeric"
                value={form.minCapacity}
                placeholder="不限"
                onChange={(event) => patch('minCapacity', event.target.value.replace(/[^\d]/g, ''))}
              />
            </label>
          </div>

          <label className="meet__field">
            <span>提醒</span>
            <select
              value={form.reminderTime}
              onChange={(event) => patch('reminderTime', Number(event.target.value))}
            >
              {REMINDERS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>

          {invalid && <p className="meet__warn">{invalid}</p>}

          <div className="meet__actions">
            <button
              type="button"
              className="meet__ghost"
              disabled={busy === 'scan' || !cookie.trim() || Boolean(invalid)}
              onClick={() => void runOnce(false)}
            >
              先查一次
            </button>
            {watching ? (
              <button type="submit" className="meet__stop">
                停止
              </button>
            ) : (
              <button type="submit" className="meet__go" disabled={!canWatch}>
                开始盯房
              </button>
            )}
          </div>
          <p className="meet__hint">
            优先订不需要审批、容量最小的空闲会议室。下单会用本机 Chrome 里已经绑定的预定密钥。Cookie 只留在这台浏览器里。
          </p>
        </form>

        <section className="meet__main">
          {booked && <div className="meet__banner">{booked}</div>}

          <div className="meet__log" aria-live="polite">
            {logs.length === 0 ? (
              <p className="meet__empty">还没查过。先查一次，或写好主题后开始盯房。</p>
            ) : (
              logs.map((line) => (
                <p key={line.id} className={`meet__logline meet__logline--${line.tone}`}>
                  <time>{line.time}</time>
                  {line.text}
                </p>
              ))
            )}
          </div>

          {scan && (
            <div className="meet__board">
              <div className="meet__board-head">
                <strong>
                  {form.site || '全部工区'} · {scan.date} {form.start}–{form.end}
                </strong>
                <span>
                  符合条件 {filtered.free.length + filtered.taken.length} 间 · 空闲 {filtered.free.length} 间
                  {scan.userName ? ` · ${scan.userName}` : ''}
                </span>
              </div>
              <div className="meet__scale" aria-hidden="true">
                <span>8:00</span>
                <span>12:00</span>
                <span>16:00</span>
                <span>20:00</span>
              </div>
              {filtered.free.length === 0 ? (
                <p className="meet__empty">这个时段没有整段空闲的会议室。</p>
              ) : (
                filtered.free.map((room) => (
                  <RoomRow key={room.roomId} room={room} start={form.start} end={form.end} free />
                ))
              )}
              {filtered.taken.length > 0 && (
                <button
                  type="button"
                  className="meet__more"
                  onClick={() => setShowBusyRooms((value) => !value)}
                >
                  {showBusyRooms ? '收起已占用' : `已占用 ${filtered.taken.length} 间`}
                </button>
              )}
              {showBusyRooms &&
                filtered.taken.map((room) => (
                  <RoomRow key={room.roomId} room={room} start={form.start} end={form.end} free={false} />
                ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function RoomRow(props: { room: MeetingRoom; start: string; end: string; free: boolean }) {
  const { room, start, end, free } = props
  const a = slotIndex(start)
  const b = slotIndex(end)
  const names = holders(room, start, end)
  const cells = []
  for (let i = BAR_FROM; i < BAR_TO; i += 1) {
    const on = i >= a && i < b
    const taken = room.busy[i] === '1'
    cells.push(
      <i
        key={i}
        className={taken ? 'is-busy' : 'is-free'}
        data-on={on ? '1' : '0'}
        title={room.who[String(i)] || (taken ? '占用' : '空闲')}
      />,
    )
  }
  return (
    <article className={free ? 'meet__room meet__room--free' : 'meet__room'}>
      <div className="meet__room-name">
        <strong>{room.roomName}</strong>
        <span>
          {room.capacity} 人 · {room.location}
          {room.resources ? ` · ${room.resources}` : ''}
        </span>
      </div>
      <div className="meet__bar">{cells}</div>
      <div className="meet__room-state">
        {room.notReserve ? (
          <em>{room.notReserveReason || '不可订'}</em>
        ) : free ? (
          <em className="is-free">{room.needApprove ? '空闲 · 需审批' : '空闲'}</em>
        ) : (
          <em>{names.length ? names.join('、') : '占用'}</em>
        )}
      </div>
    </article>
  )
}
