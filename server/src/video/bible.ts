/**
 * 系列设定：角色外形、衣橱、场景底板、某一天的物件位置。
 * 分镜只写这一镜发生了什么，出图提示词由这里拼，避免每镜重画一张脸、一间房。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readJsonFile, writeJsonAtomic } from '../jsonStore.js'
import { VIDEO_DIR } from './store.js'
import type { Shot } from './types.js'

export type PropSpot = { name: string; where: string }

export type BibleCharacter = { id: string; name: string; look: string; images?: string[]; voiceId?: string }
export type BibleOutfit = { id: string; characterId: string; name: string; look: string; images?: string[] }
export type BiblePlace = { id: string; name: string; look: string; props: PropSpot[]; images?: string[] }
export type BibleDay = {
  id: string
  title: string
  /** 这一天各场景走到现在的物件位置。没有记录时用场景底板上的默认位置。 */
  places: Record<string, PropSpot[]>
}

export type SeriesBible = {
  characters: BibleCharacter[]
  outfits: BibleOutfit[]
  places: BiblePlace[]
  days: BibleDay[]
  activeDayId: string
}

const FILE = path.join(VIDEO_DIR, 'bible.json')
const LIBRARY = path.join(VIDEO_DIR, 'library.json')
const REFS = path.join(VIDEO_DIR, 'refs')

function refName(raw: unknown): string {
  const name = text(raw)
  return /^ref_[0-9a-f]+\.(png|jpg|webp)$/.test(name) ? name : ''
}

function refList(raw: unknown, legacy?: unknown): string[] {
  const fromList = Array.isArray(raw) ? raw.map(refName).filter(Boolean) : []
  const one = refName(legacy)
  const all = one && !fromList.includes(one) ? [one, ...fromList] : fromList
  return [...new Set(all)].slice(0, 8)
}

export function saveBibleImage(buf: Buffer): string {
  let ext = ''
  const hex = buf.subarray(0, 4).toString('hex')
  if (hex === '89504e47') ext = 'png'
  else if (hex.startsWith('ffd8')) ext = 'jpg'
  else if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') ext = 'webp'
  else throw new Error('只收 png、jpg、webp')
  const name = `ref_${crypto.randomBytes(6).toString('hex')}.${ext}`
  fs.mkdirSync(REFS, { recursive: true })
  fs.writeFileSync(path.join(REFS, name), buf)
  return name
}

export function bibleImageFile(name: string): string | null {
  if (!refName(name)) return null
  const file = path.join(REFS, name)
  return fs.existsSync(file) ? file : null
}

export function fileDigest(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export function readLibrary(): string[] {
  const raw = readJsonFile<unknown>(LIBRARY)
  return Array.isArray(raw) ? raw.map(refName).filter(Boolean).slice(-40) : []
}

export function addLibraryImage(name: string): string[] {
  if (!bibleImageFile(name)) throw new Error('没有这张图')
  const cur = readLibrary().filter((item) => item !== name)
  cur.push(name)
  writeJsonAtomic(LIBRARY, cur.slice(-40))
  return cur.slice(-40)
}

function nid(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(3).toString('hex')}`
}

function text(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

function spots(raw: unknown): PropSpot[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
      const name = text(row.name)
      if (!name) return null
      return { name, where: text(row.where) }
    })
    .filter((item): item is PropSpot => Boolean(item))
    .slice(0, 24)
}

export function blankBible(): SeriesBible {
  const dayId = nid('day')
  return {
    characters: [],
    outfits: [],
    places: [],
    days: [{ id: dayId, title: '第1天', places: {} }],
    activeDayId: dayId,
  }
}

function cleanBible(raw: Partial<SeriesBible> | null): SeriesBible {
  const base = blankBible()
  if (!raw) return base
  const characters = Array.isArray(raw.characters)
    ? raw.characters
        .map((item) => {
          const row = item as Partial<BibleCharacter> & { image?: unknown; images?: unknown }
          const name = text(row.name)
          if (!name) return null
          const images = refList(row.images, row.image)
          const character: BibleCharacter = { id: text(row.id) || nid('c'), name, look: text(row.look) }
          if (images.length) character.images = images
          const voiceId = text((row as { voiceId?: unknown }).voiceId)
          if (voiceId) character.voiceId = voiceId
          return character
        })
        .filter((item): item is BibleCharacter => item !== null)
        .slice(0, 24)
    : []
  const outfits = Array.isArray(raw.outfits)
    ? raw.outfits
        .map((item) => {
          const row = item as Partial<BibleOutfit> & { image?: unknown; images?: unknown }
          const name = text(row.name)
          const characterId = text(row.characterId)
          if (!name || !characters.some((c) => c?.id === characterId)) return null
          const images = refList(row.images, row.image)
          const outfit: BibleOutfit = { id: text(row.id) || nid('o'), characterId, name, look: text(row.look) }
          if (images.length) outfit.images = images
          return outfit
        })
        .filter((item): item is BibleOutfit => item !== null)
        .slice(0, 48)
    : []
  const places = Array.isArray(raw.places)
    ? raw.places
        .map((item) => {
          const row = item as Partial<BiblePlace> & { image?: unknown; images?: unknown }
          const name = text(row.name)
          if (!name) return null
          const images = refList(row.images, row.image)
          const place: BiblePlace = { id: text(row.id) || nid('p'), name, look: text(row.look), props: spots(row.props) }
          if (images.length) place.images = images
          return place
        })
        .filter((item): item is BiblePlace => item !== null)
        .slice(0, 24)
    : []
  const days = Array.isArray(raw.days)
    ? raw.days
        .map((item) => {
          const row = item as Partial<BibleDay>
          const title = text(row.title)
          if (!title) return null
          const placeMap: Record<string, PropSpot[]> = {}
          if (row.places && typeof row.places === 'object') {
            for (const [placeId, value] of Object.entries(row.places)) {
              if (places.some((place) => place?.id === placeId)) placeMap[placeId] = spots(value)
            }
          }
          return { id: text(row.id) || nid('day'), title, places: placeMap }
        })
        .filter((item): item is BibleDay => Boolean(item))
        .slice(0, 31)
    : []
  const nextDays = days.length ? days : base.days
  const activeDayId = nextDays.some((day) => day.id === raw.activeDayId) ? String(raw.activeDayId) : nextDays[0].id
  return { characters, outfits, places, days: nextDays, activeDayId }
}

export function readBible(): SeriesBible {
  return cleanBible(readJsonFile<Partial<SeriesBible>>(FILE))
}

export function writeBible(input: SeriesBible): SeriesBible {
  const clean = cleanBible(input)
  writeJsonAtomic(FILE, clean)
  return clean
}

function brief(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 36 ? `${line.slice(0, 36)}…` : line
}

/** 给写剧本的模型看：只用这些名字，外形细节留给拆分镜。 */
export function scriptCast(bible: SeriesBible): string {
  const people = bible.characters
    .filter((character) => character.name.trim())
    .map((character) => {
      const clothes = bible.outfits
        .filter((outfit) => outfit.characterId === character.id && outfit.name.trim())
        .map((outfit) => outfit.name)
        .join('、')
      const look = brief(character.look)
      return `- ${character.name}${look ? `：${look}` : ''}${clothes ? `。衣橱：${clothes}` : ''}`
    })
  const rooms = bible.places
    .filter((place) => place.name.trim())
    .map((place) => {
      const look = brief(place.look)
      return `- ${place.name}${look ? `：${look}` : ''}`
    })
  if (!people.length && !rooms.length) return ''
  return `已保存的设定。剧本里的角色和地点只能用这些名字：\n角色：\n${people.join('\n') || '（无）'}\n场景：\n${rooms.join('\n') || '（无）'}\n写出名字即可，不要把外形、衣服和房间陈设再写进剧本。`
}

export function bibleCatalog(bible: SeriesBible): string {
  if (!bible.characters.length && !bible.places.length && !bible.outfits.length) return ''
  const people = bible.characters
    .map((character) => {
      const clothes = bible.outfits.filter((outfit) => outfit.characterId === character.id)
      const wardrobe = clothes.map((outfit) => `${outfit.id} ${outfit.name}`).join('、') || '无'
      return `- ${character.id} ${character.name}。衣橱：${wardrobe}`
    })
    .join('\n')
  const rooms = bible.places.map((place) => `- ${place.id} ${place.name}`).join('\n')
  return `可用角色：\n${people || '（无）'}\n可用场景：\n${rooms || '（无）'}`
}

function cloneSpots(list: PropSpot[]): PropSpot[] {
  return list.map((item) => ({ name: item.name, where: item.where }))
}

function applyChanges(props: PropSpot[], changes: PropSpot[]): PropSpot[] {
  const next = cloneSpots(props)
  for (const change of changes) {
    const name = change.name.trim()
    if (!name) continue
    const where = change.where.trim()
    const idx = next.findIndex((item) => item.name === name)
    if (!where) {
      if (idx >= 0) next.splice(idx, 1)
      continue
    }
    if (idx >= 0) next[idx] = { name, where }
    else next.push({ name, where })
  }
  return next
}

/** 这一镜该角色要穿的每一件。编号对上就穿那几件，一个都没对上就穿他衣橱里的全部。 */
function wornOutfits(shot: Shot, characterId: string, bible: SeriesBible): BibleOutfit[] {
  const owned = bible.outfits.filter((item) => item.characterId === characterId && item.name.trim())
  const ids = new Set(shot.outfitIds ?? [])
  const picked = owned.filter((item) => ids.has(item.id))
  return picked.length ? picked : owned
}

function clothesLine(outfits: BibleOutfit[]): string {
  if (!outfits.length) return '穿着该角色衣橱里已有的衣服，不要新设计服装。'
  const pieces = outfits
    .map((outfit) => {
      const look = outfit.look.trim().replace(/。+$/, '')
      return look ? `「${outfit.name}」${look}` : `「${outfit.name}」按它的参考图`
    })
    .join('；')
  const shoes = outfits.some((outfit) => /鞋/.test(`${outfit.name}${outfit.look}`))
  const feet = shoes
    ? '脚上只穿衣橱里写明的鞋，每一镜同一双，不要换款，也不要改成光脚。'
    : '脚上不要画任何鞋，不要运动鞋、皮鞋、拖鞋或高跟鞋，每一镜都一样。'
  return `同时穿上这几件，一件都不能少：${pieces}。不要自行加裤子、裙子、外套把它们盖住。${feet}`
}

function shotPrompt(shot: Shot, bible: SeriesBible, props: PropSpot[]): string {
  const names = shot.characters
  const people = names
    .map((name) => {
      const character = bible.characters.find((item) => item.name === name || item.id === name)
      if (!character) return ''
      const look = character.look.trim().replace(/。$/, '')
      return `${character.name}，外形固定为：${look}。${clothesLine(wornOutfits(shot, character.id, bible))}`
    })
    .filter(Boolean)
  const place = bible.places.find((item) => item.id === shot.placeId)
  const room = place ? `场景「${place.name}」固定为：${place.look}。` : ''
  const layout = props.length
    ? `物件必须画在这些位置，不要挪动：${props.map((item) => `${item.name}在${item.where}`).join('；')}。`
    : ''
  const hasRef =
    names.some((name) => {
      const character = bible.characters.find((item) => item.name === name || item.id === name)
      if (!character) return false
      return Boolean(character.images?.length) || wornOutfits(shot, character.id, bible).some((item) => item.images?.length)
    }) || Boolean(place?.images?.length)
  return [
    '漫剧分镜，统一线稿，平涂上色。只画这一镜的单幅画面。',
    hasRef ? '参考图顺序是角色定妆、这一镜要穿的每一件衣服、场景底板。脸、衣服和房间以参考图为准，不要另画。' : '',
    people.length ? people.join(' ') : '',
    room,
    layout,
    `景别${shot.shotSize}。本镜只发生这件事：${shot.description}`,
  ]
    .filter(Boolean)
    .join('')
}

export function referenceFilesForShot(shot: Shot): string[] {
  const bible = readBible()
  const files: string[] = []
  const push = (name?: string) => {
    if (!name || files.length >= 16) return
    const file = bibleImageFile(name)
    if (file && !files.includes(file)) files.push(file)
  }
  const pushAll = (names?: string[]) => names?.forEach(push)
  shot.characters.forEach((name) => {
    const character = bible.characters.find((item) => item.name === name || item.id === name)
    pushAll(character?.images)
    if (!character) return
    for (const outfit of wornOutfits(shot, character.id, bible)) pushAll(outfit.images)
  })
  pushAll(bible.places.find((item) => item.id === shot.placeId)?.images)
  return files
}

/** 按当天已经发生的位置拼提示词。commit 为真时，把这一条结束时的位置写回这一天。 */
export function lockShots(shots: Shot[], commit: boolean): Shot[] {
  const bible = readBible()
  if (!bible.characters.length && !bible.places.length) return shots
  const day = bible.days.find((item) => item.id === bible.activeDayId) ?? bible.days[0]
  const running: Record<string, PropSpot[]> = {}
  const locked = shots.map((shot) => {
    const place = bible.places.find((item) => item.id === shot.placeId)
    if (!place) return { ...shot, firstFramePrompt: shotPrompt(shot, bible, []) }
    if (!running[place.id]) running[place.id] = cloneSpots(day?.places[place.id] ?? place.props)
    const props = running[place.id]
    const next = { ...shot, firstFramePrompt: shotPrompt(shot, bible, props) }
    running[place.id] = applyChanges(props, shot.propChanges ?? [])
    return next
  })
  if (commit && day) {
    day.places = { ...day.places, ...running }
    writeBible({ ...bible, days: bible.days.map((item) => (item.id === day.id ? day : item)) })
  }
  return locked
}
