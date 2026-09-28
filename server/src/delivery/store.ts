import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../paths.js'
import type { DeliveryRun, Seat } from './types.js'

const FILE = path.join(DATA_DIR, 'delivery.json')

function emptyRun(): DeliveryRun {
  return {
    id: `run-${Date.now().toString(36)}`,
    seat: 'pm',
    phase: 'drafting',
    stale: false,
    dirtyWarning: false,
    prd: {
      title: '',
      oneLiner: '',
      body: '',
      acceptance: [],
      confirmed: false,
      version: 1,
    },
    questions: [],
    talk: [],
    lastErrors: [],
    gates: [],
  }
}

let cached: DeliveryRun | null = null

export function getRun(): DeliveryRun {
  if (cached) return cached
  try {
    cached = JSON.parse(fs.readFileSync(FILE, 'utf8')) as DeliveryRun
    if (!Array.isArray(cached.talk)) cached.talk = []
    if (!Array.isArray(cached.lastErrors)) cached.lastErrors = []
    return cached
  } catch {
    cached = emptyRun()
    return cached
  }
}

export function saveRun(run: DeliveryRun): DeliveryRun {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(run, null, 2), 'utf8')
  cached = run
  return run
}

export function setSeat(seat: Seat): DeliveryRun {
  const run = getRun()
  run.seat = seat
  return saveRun(run)
}

export function resetRun(): DeliveryRun {
  cached = emptyRun()
  return saveRun(cached)
}
