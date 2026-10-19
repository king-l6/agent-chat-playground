/**
 * 费哲会议室：查询某天占用，并用页面同一套签名预定。
 *
 * 签名从预定页脚本里对出来的，两段都要带：
 *   sign        = md5(roomId + start + end + reminderTime + userId)
 *   browserSign = ECDSA-P256(SHA-256) 对
 *                 roomId + start + end + reminderTime + userId + clientId + 毫秒时间戳 + "1"
 * 公钥每次下单前用「booking-key-init:」+ SPKI(base64) 签一次，注册到当前登录态。
 * Cookie 只在这一次请求里转发，不落盘。
 */
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ORIGIN = 'https://administration.biliapi.net'
const PREFIX = '/f1-space'

const SLOT_COUNT = 48
const SLOT_MINUTES = 30

type F1Json = {
  success?: boolean
  status?: string
  code?: string
  message?: string
  data?: unknown
  total?: number
}

class MeetingError extends Error {
  reason?: string
}

type RawSlot = {
  reservationUserName?: string | null
  available?: boolean
  seize?: boolean
}

type RawRoom = {
  roomId?: number
  roomName?: string
  capacity?: number
  location?: string
  resources?: string
  needApprove?: boolean
  reservableStart?: string
  reservableEnd?: string
  notReserve?: boolean | null
  notReserveReason?: string | null
  meetingCalendarResponseList?: RawSlot[] | null
}

export type MeetingRoom = {
  roomId: number
  roomName: string
  capacity: number
  location: string
  resources: string
  needApprove: boolean
  reservableStart: string
  reservableEnd: string
  notReserve: boolean
  notReserveReason: string
  /** 48 格，从 00:00 起每格 30 分钟。1 = 这段已被占或不可订 */
  busy: string
  /** 被占格子的下标 → 预定人。空闲格不出现 */
  who: Record<string, string>
}

export type MeetingScan = {
  date: string
  total: number
  userId: number | null
  userName: string
  rooms: MeetingRoom[]
}

export type MeetingBookInput = {
  cookie: string
  roomId: number
  start: string
  end: string
  subject: string
  reminderTime: number
}

type KeyMat = { privatePem: string; publicB64: string }

const keys = new Map<string, KeyMat>()
const tails = new Map<string, Promise<unknown>>()

function normalizeCookie(raw: string): string {
  let cookie = raw.trim()
  if (cookie.toLowerCase().startsWith('cookie:')) cookie = cookie.slice('cookie:'.length).trim()
  if (!cookie) throw new Error('先粘贴登录 Cookie')
  if (cookie.length > 16_000) throw new Error('Cookie 太长了')
  return cookie
}

function assertDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式应为 YYYY-MM-DD')
  return date
}

function assertStamp(label: string, value: string): string {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    throw new Error(`${label}格式应为 YYYY-MM-DD HH:mm:ss`)
  }
  return value
}

function cookieKey(cookie: string): string {
  return crypto.createHash('sha256').update(cookie).digest('hex').slice(0, 16)
}

function lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(id) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  tails.set(
    id,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

function keyFor(cookie: string): KeyMat {
  const id = cookieKey(cookie)
  const hit = keys.get(id)
  if (hit) return hit
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const created: KeyMat = {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  }
  keys.set(id, created)
  return created
}

function signRaw(privatePem: string, message: string): string {
  return crypto
    .sign('sha256', Buffer.from(message, 'utf8'), { key: privatePem, dsaEncoding: 'ieee-p1363' })
    .toString('base64')
}

function md5(message: string): string {
  return crypto.createHash('md5').update(message).digest('hex')
}

async function f1(cookie: string, path: string, body?: unknown): Promise<F1Json> {
  const res = await fetch(`${ORIGIN}${PREFIX}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/json',
      cookie,
      currentlocale: 'zh_CN',
      origin: ORIGIN,
      referer: `${ORIGIN}/f1-space/web/index.html`,
      source: 'web',
      'x-requested-with': 'XMLHttpRequest',
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: F1Json
  try {
    json = JSON.parse(text) as F1Json
  } catch {
    throw new Error(`会议室接口返回了非 JSON（HTTP ${res.status}）`)
  }
  if (!res.ok || json.success === false || (json.status && json.status !== 'success')) {
    const reason = (json.data as { reason?: unknown } | null)?.reason
    const error = new MeetingError(json.message || `会议室接口失败（HTTP ${res.status}）`)
    if (typeof reason === 'string') error.reason = reason
    throw error
  }
  return json
}

type BrowserSign = {
  browserSign: string
  browserSignVersion: '1'
  browserSignTime: number
  browserSignClientId: string
}

/**
 * 预定密钥是不可导出的，存在本机 Chrome 的 IndexedDB 里。
 * 只能让 Chrome 在会议室站点上签。需要菜单里打开一次：
 * 查看 → 开发者 → 允许 Apple 事件中的 JavaScript。
 */
async function signWithChrome(joined: string): Promise<BrowserSign> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meet-sign-'))
  const jsPath = path.join(dir, 'sign.js')
  const pollPath = path.join(dir, 'poll.js')
  const token = crypto.randomBytes(8).toString('hex')
  const js = `
    window.__agentMeet = window.__agentMeet || {};
    window.__agentMeet[${JSON.stringify(token)}] = "pending";
    (async function () {
      var payload = ${JSON.stringify(joined)};
      function b64(buf) {
        var bytes = new Uint8Array(buf), text = "";
        for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
        return btoa(text);
      }
      function openDb() {
        return new Promise(function (resolve, reject) {
          var req = indexedDB.open("fm_booking_sign", 1);
          req.onupgradeneeded = function () {
            var db = req.result;
            if (!db.objectStoreNames.contains("booking_key")) {
              db.createObjectStore("booking_key", { keyPath: "id" });
            }
          };
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { reject(req.error); };
        });
      }
      try {
        var db = await openDb();
        var row = await new Promise(function (resolve, reject) {
          var req = db.transaction("booking_key", "readonly").objectStore("booking_key").get("current");
          req.onsuccess = function () { resolve(req.result || null); };
          req.onerror = function () { reject(req.error); };
        });
        db.close();
        if (!row || !row.privateKey || !row.clientId) {
          window.__agentMeet[${JSON.stringify(token)}] = JSON.stringify({ error: "浏览器里还没有预定密钥" });
          return;
        }
        var time = Date.now();
        var sig = await crypto.subtle.sign(
          { name: "ECDSA", hash: { name: "SHA-256" } },
          row.privateKey,
          new TextEncoder().encode(payload + row.clientId + time + "1")
        );
        window.__agentMeet[${JSON.stringify(token)}] = JSON.stringify({
          browserSign: b64(sig),
          browserSignVersion: "1",
          browserSignTime: time,
          browserSignClientId: row.clientId
        });
      } catch (err) {
        window.__agentMeet[${JSON.stringify(token)}] = JSON.stringify({ error: String(err && err.message || err) });
      }
    })();
    "pending";
  `
  await fs.writeFile(jsPath, js)
  await fs.writeFile(pollPath, `window.__agentMeet && window.__agentMeet[${JSON.stringify(token)}]`)
  try {
    await runInMeetingTab(jsPath)
    const started = Date.now()
    let last = 'pending'
    while (Date.now() - started < 8000) {
      last = await runInMeetingTab(pollPath)
      if (last && last !== 'pending' && last !== 'missing value') break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    if (!last || last === 'pending' || last === 'missing value') {
      throw new Error('Chrome 里的签名没有返回')
    }
    const parsed = JSON.parse(last) as BrowserSign & { error?: string }
    if (parsed.error) throw new Error(parsed.error)
    if (!parsed.browserSign || !parsed.browserSignClientId) throw new Error('Chrome 签名不完整')
    return parsed
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

async function runInMeetingTab(jsPath: string): Promise<string> {
  const script = `
on run argv
  set js to read POSIX file (item 1 of argv) as «class utf8»
  tell application "Google Chrome"
    if (count of windows) = 0 then error "请先打开 Chrome"
    -- 先在当前标签探一下。没开「允许 Apple 事件中的 JavaScript」时在这里失败，不会新开会议室页。
    set probe to execute active tab of front window javascript "String(1)"
    set targetTab to missing value
    repeat with w in windows
      repeat with t in tabs of w
        if (URL of t as text) starts with "https://administration.biliapi.net/" then
          set targetTab to t
          exit repeat
        end if
      end repeat
      if targetTab is not missing value then exit repeat
    end repeat
    if targetTab is missing value then
      tell front window
        set targetTab to make new tab with properties {URL:"https://administration.biliapi.net/f1-space/web/index.html"}
      end tell
      repeat 25 times
        delay 0.2
        if (URL of targetTab as text) starts with "https://administration.biliapi.net/" and loading of targetTab is false then exit repeat
      end repeat
    end if
    return execute targetTab javascript js
  end tell
end run
`
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script, jsPath], {
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    })
    return stdout.trim()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('允许 Apple 事件') || message.includes('JavaScript')) {
      throw new Error(
        'Chrome 还没允许脚本签名。打开 Chrome，菜单选「查看 → 开发者 → 允许 Apple 事件中的 JavaScript」，然后重新开始盯房。不用重新登录。',
      )
    }
    if (message.includes('Google Chrome') && message.includes('不能获得')) {
      throw new Error('没有找到 Google Chrome')
    }
    throw new Error(message.replace(/\s+/g, ' ').slice(0, 240))
  }
}

function execFileAsync(file: string, args: string[], opts: { timeout: number; maxBuffer: number }) {
  return new Promise<{ stdout: string }>((resolve, reject) => {
    execFile(file, args, { timeout: opts.timeout, maxBuffer: opts.maxBuffer }, (err, stdout, stderr) => {
      if (err) {
        const wrapped = new Error(`${err.message} ${stderr || ''}`.trim())
        reject(wrapped)
        return
      }
      resolve({ stdout: String(stdout) })
    })
  })
}

async function currentUser(cookie: string): Promise<{ userId: number; userName: string }> {
  const json = await f1(cookie, '/settings/emps/baseInfo')
  const data = json.data as { userId?: unknown; userName?: unknown } | null
  const userId = Number(data?.userId)
  if (!Number.isFinite(userId)) throw new Error('没有读到当前用户，Cookie 可能过期了')
  return { userId, userName: typeof data?.userName === 'string' ? data.userName : '' }
}

function toRoom(raw: RawRoom): MeetingRoom | null {
  if (typeof raw.roomId !== 'number' || !raw.roomName) return null
  const slots = raw.meetingCalendarResponseList ?? []
  const bits: string[] = []
  const who: Record<string, string> = {}
  for (let i = 0; i < SLOT_COUNT; i += 1) {
    const slot = slots[i]
    const free = Boolean(slot && slot.available && !slot.seize)
    bits.push(free ? '0' : '1')
    const name = slot?.reservationUserName?.trim()
    if (!free && name) who[String(i)] = name
  }
  return {
    roomId: raw.roomId,
    roomName: raw.roomName,
    capacity: Number(raw.capacity) || 0,
    location: raw.location ?? '',
    resources: raw.resources ?? '',
    needApprove: Boolean(raw.needApprove),
    reservableStart: raw.reservableStart || '00:00',
    reservableEnd: raw.reservableEnd || '23:59',
    notReserve: Boolean(raw.notReserve),
    notReserveReason: raw.notReserveReason ?? '',
    busy: bits.join(''),
    who,
  }
}

export async function scanMeetingRooms(cookieRaw: string, dateRaw: string): Promise<MeetingScan> {
  const cookie = normalizeCookie(cookieRaw)
  const date = assertDate(dateRaw.trim())
  const [userResult, listResult] = await Promise.allSettled([
    currentUser(cookie),
    f1(cookie, '/meeting/order/spaces', {
      conditions: [{ field: 'bookDate', opt: '=', values: [date] }],
      columns: [],
      draw: 2,
      offset: 0,
      pageNumber: 1,
      pageSize: 500,
    }),
  ])
  if (listResult.status === 'rejected') throw listResult.reason
  const json = listResult.value
  const rows = Array.isArray(json.data) ? (json.data as RawRoom[]) : []
  const rooms = rows.flatMap((row) => {
    const room = toRoom(row)
    return room ? [room] : []
  })
  const user = userResult.status === 'fulfilled' ? userResult.value : { userId: null, userName: '' }
  return {
    date,
    total: typeof json.total === 'number' ? json.total : rooms.length,
    userId: user.userId,
    userName: user.userName,
    rooms,
  }
}

async function registerKey(cookie: string, key: KeyMat): Promise<string> {
  const proofSignature = signRaw(key.privatePem, `booking-key-init:${key.publicB64}`)
  const json = await f1(cookie, '/security/booking-key/init', {
    publicKey: key.publicB64,
    proofSignature,
    browserSignVersion: '1',
  })
  const clientId = (json.data as { clientId?: unknown } | null)?.clientId
  if (typeof clientId !== 'string' || !clientId) throw new Error('浏览器安全密钥初始化没有返回 clientId')
  return clientId
}

export async function bookMeeting(input: MeetingBookInput): Promise<{ ok: true; message: string; userName: string }> {
  const cookie = normalizeCookie(input.cookie)
  const roomId = input.roomId
  if (!Number.isInteger(roomId) || roomId <= 0) throw new Error('会议室不对')
  const start = assertStamp('开始时间', input.start.trim())
  const end = assertStamp('结束时间', input.end.trim())
  if (start >= end) throw new Error('结束时间要晚于开始时间')
  const subject = input.subject.trim()
  if (!subject) throw new Error('先写会议主题')
  if (subject.length > 80) throw new Error('会议主题太长了')
  const reminderTime = input.reminderTime
  if (!Number.isInteger(reminderTime) || reminderTime < 0 || reminderTime > 6) {
    throw new Error('提醒时间不在可选范围内')
  }

  return lock(cookieKey(cookie), async () => {
    const user = await currentUser(cookie)
    const joined = `${roomId}${start}${end}${reminderTime}${user.userId}`
    let browser: BrowserSign
    try {
      browser = await signWithChrome(joined)
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('还没有预定密钥')) throw err
      const key = keyFor(cookie)
      let clientId: string
      try {
        clientId = await registerKey(cookie, key)
      } catch (initErr) {
        if (initErr instanceof MeetingError && initErr.reason === 'KEY_ALREADY_BOUND') {
          throw new Error(
            '预定密钥在 Chrome 里，但这个页面没读到。先打开会议室网页，确认菜单「查看 → 开发者 → 允许 Apple 事件中的 JavaScript」已勾上，再重新盯房。',
          )
        }
        throw initErr
      }
      const browserSignTime = Date.now()
      browser = {
        browserSign: signRaw(key.privatePem, `${joined}${clientId}${browserSignTime}1`),
        browserSignVersion: '1',
        browserSignTime,
        browserSignClientId: clientId,
      }
    }
    const json = await f1(cookie, '/meeting/order', {
      roomId,
      start,
      end,
      subject,
      content: '',
      attendeeList: [],
      reminderTime,
      services: [],
      remarks: '',
      userId: user.userId,
      attachments: [],
      sign: md5(joined),
      browserSign: browser.browserSign,
      browserSignVersion: '1',
      browserSignTime: browser.browserSignTime,
      browserSignClientId: browser.browserSignClientId,
    })
    return { ok: true as const, message: json.message || '预定成功', userName: user.userName }
  })
}

export const MEETING_SLOT_MINUTES = SLOT_MINUTES
