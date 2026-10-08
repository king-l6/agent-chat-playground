export type Seat = 'pm' | 'dev' | 'qa'
export type DeliveryRole = 'pm' | 'dev' | 'review' | 'qa'
export type Phase =
  | 'drafting'
  | 'developing'
  | 'blocked_on_pm'
  | 'reviewing'
  | 'testing'
  | 'signed'

export type AllowedCommand = 'eval:rag' | 'tsc' | 'lint'
export type AcResult = 'pass' | 'fail' | 'needs_human'

export type Acceptance = {
  id: string
  text: string
  kind: 'auto' | 'manual'
  command?: AllowedCommand
  observable?: string
  checkedByPm: boolean
}

export type Prd = {
  title: string
  oneLiner: string
  body: string
  acceptance: Acceptance[]
  confirmed: boolean
  confirmedAt?: string
  version: number
}

export type TalkTraceStep = {
  id: string
  name: string
  arguments: string
  status: 'running' | 'done' | 'error'
  result?: string
  error?: string
}

export type TalkTrace = { steps: TalkTraceStep[]; live?: string }

export type TalkTurn = { role: 'user' | 'assistant'; content: string; trace?: TalkTrace }

export type Patch = {
  summary: string
  files: string[]
  status?: string
  diff?: string
  /** 本轮由脚手架兜底补齐的工程文件（模型自己写全了就没有这个字段） */
  scaffold?: { written: string[]; missingBefore: string[] }
}
export type ReviewComment = { path: string; risk: string; mustFix: boolean }
export type Review = { comments: ReviewComment[]; riskReason?: string }
export type TestItem = { acId: string; result: AcResult; detail: string }
export type TestReport = {
  items: TestItem[]
  commandLogs: { command: string; exitCode: number; excerpt: string }[]
  riskReason?: string
}
export type ReleaseNotes = { text: string; files: string[] }

export type GateAction =
  | 'confirm'
  | 'withdraw'
  | 'bounce_pm'
  | 'keep_prd'
  | 'dev_done'
  | 'review_bounce'
  | 'review_pass'
  | 'review_risk'
  | 'test_bounce'
  | 'test_sign'
  | 'test_risk'

export type GateEvent = {
  action: GateAction
  actor: Seat
  at: string
  reason?: string
}

export type DeliveryRun = {
  id: string
  /** 这条需求对着哪个本地仓库；缺省回落全局默认工作区 */
  workspaceRoot?: string
  createdAt?: string
  updatedAt?: string
  seat: Seat
  phase: Phase
  stale: boolean
  dirtyWarning: boolean
  prd: Prd
  patch?: Patch
  review?: Review
  test_report?: TestReport
  release_notes?: ReleaseNotes
  questions: string[]
  talk: TalkTurn[]
  lastErrors?: string[]
  gates: GateEvent[]
}

/** 磁盘上的交付状态：一组需求 + 当前激活哪条 */
export type DeliveryStore = {
  version: 2
  activeId: string
  runs: DeliveryRun[]
}

/** 需求列表用的轻量摘要，不带 talk/patch 这些大块 */
export type RunSummary = {
  id: string
  title: string
  phase: Phase
  seat: Seat
  workspaceRoot?: string
  signed: boolean
  updatedAt?: string
}

export class GateError extends Error {
  constructor(
    public gate: string,
    message: string,
  ) {
    super(message)
    this.name = 'GateError'
  }
}
