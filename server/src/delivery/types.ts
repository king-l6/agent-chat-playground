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

export type Patch = { summary: string; files: string[] }
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
  gates: GateEvent[]
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
