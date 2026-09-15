/**
 * 产品和 AI 多轮改 PRD。有 Key 走模型，没有就按原话拼一版，下一轮还能继续改。
 */
import OpenAI from 'openai'
import { resolveLlmConfig } from '../agent.js'
import type { Acceptance, Prd, TalkTurn } from './types.js'

function defaultAcceptance(): Acceptance[] {
  return [
    {
      id: 'ac-see',
      text: '按文档说的功能，能在选中仓库的代码或界面里看到对应改动',
      kind: 'manual',
      observable: 'git diff 对得上需求，而不是只加了一道评测题',
      checkedByPm: false,
    },
    {
      id: 'ac-tsc',
      text: '在选中的仓库跑 tsc，退出码 0',
      kind: 'auto',
      command: 'tsc',
      checkedByPm: false,
    },
  ]
}

function keepChecks(prev: Acceptance[], next: Acceptance[]): Acceptance[] {
  const map = new Map(prev.map((a) => [a.id, a.checkedByPm]))
  return next.map((a) => ({ ...a, checkedByPm: map.get(a.id) ?? a.checkedByPm }))
}

export function mockRefine(prev: Prd, message: string, round: number): { prd: Prd; reply: string } {
  const line = message.trim()
  if (!prev.title) {
    return {
      prd: {
        ...prev,
        oneLiner: line,
        title: line.length > 24 ? `${line.slice(0, 24)}…` : line,
        body: `背景\n${line}\n\n范围\n按这句话在选中的仓库里改现有代码，实现这个功能。不要用加评测题代替实现。\n\n完成\n研发改完能看到对应文件的 git diff。`,
        acceptance: prev.acceptance.length ? prev.acceptance : defaultAcceptance(),
        confirmed: false,
        version: prev.version + 1,
      },
      reply: '我先按你这句话铺了一版需求。右边是文档。觉得哪句不对，接着说，我再改。勾过至少一条验收，才能交给研发。',
    }
  }
  return {
    prd: {
      ...prev,
      oneLiner: line,
      body: `${prev.body.trim()}\n\n产品补充（第 ${round} 轮）\n${line}`,
      acceptance: prev.acceptance.length ? prev.acceptance : defaultAcceptance(),
      confirmed: false,
      version: prev.version + 1,
    },
    reply: '按你这轮意见改进文档了。再看看右边。还要改就继续说；验收对了就勾上，点「交给研发」。',
  }
}

function parsePrdJson(raw: string): {
  title?: string
  body?: string
  acceptance?: Acceptance[]
  reply?: string
} | null {
  const fenced = raw.match(/\{[\s\S]*\}/)
  const text = fenced?.[0] ?? raw
  try {
    const data = JSON.parse(text) as {
      title?: string
      body?: string
      acceptance?: Array<Partial<Acceptance>>
      reply?: string
    }
    const acceptance = (data.acceptance ?? [])
      .filter((a) => typeof a.text === 'string' && a.text.trim())
      .map((a, i) => ({
        id: typeof a.id === 'string' && a.id ? a.id : `ac-${i + 1}`,
        text: String(a.text).trim(),
        kind: a.kind === 'manual' ? ('manual' as const) : ('auto' as const),
        command:
          a.command === 'eval:rag' || a.command === 'tsc' || a.command === 'lint'
            ? a.command
            : a.kind === 'manual'
              ? undefined
              : 'eval:rag',
        observable: typeof a.observable === 'string' ? a.observable : undefined,
        checkedByPm: false,
      }))
    return {
      title: typeof data.title === 'string' ? data.title : undefined,
      body: typeof data.body === 'string' ? data.body : undefined,
      acceptance: acceptance.length ? acceptance : undefined,
      reply: typeof data.reply === 'string' ? data.reply : undefined,
    }
  } catch {
    return null
  }
}

export async function refinePrd(
  prev: Prd,
  talk: TalkTurn[],
  message: string,
): Promise<{ prd: Prd; reply: string; live: boolean }> {
  const round = talk.filter((t) => t.role === 'user').length
  const { apiKey, baseURL, model } = resolveLlmConfig()
  if (!apiKey) {
    const mocked = mockRefine(prev, message, Math.max(1, round))
    return { ...mocked, live: false }
  }

  const client = new OpenAI({ apiKey, baseURL })
  const history = talk.slice(-8).map((t) => ({
    role: t.role,
    content: t.content,
  }))
  const res = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: `你帮产品把他刚说的功能收成一份可交接的 PRD。只改文档，不写代码。
返回一个 JSON 对象，不要 markdown：
{"title":"...","body":"...","acceptance":[{"id":"ac-1","text":"...","kind":"auto|manual","command":"eval:rag|tsc|lint","observable":"..."}],"reply":"对产品说的短中文"}
规则：
- 严格按产品这轮原意写，不要换成别的示例功能，不要自己编一套题库/评测故事。
- body 用中文，分段写背景 / 范围 / 完成。
- acceptance 至少 1 条，要能判定。能跑命令的用 kind=auto 并带 command（eval:rag / tsc / lint）。
- reply 是跟产品说话，问不清的地方，不要复述整份文档。
- 保留已有验收 id，方便产品继续勾选。`,
      },
      {
        role: 'user',
        content: `当前文档：\n${JSON.stringify({ title: prev.title, body: prev.body, acceptance: prev.acceptance }, null, 2)}\n\n产品这轮说：${message}`,
      },
      ...history,
    ],
  })
  const parsed = parsePrdJson(res.choices[0]?.message?.content ?? '')
  if (!parsed) {
    const mocked = mockRefine(prev, message, Math.max(1, round))
    return { ...mocked, live: false }
  }
  const acceptance = keepChecks(
    prev.acceptance,
    parsed.acceptance ?? (prev.acceptance.length ? prev.acceptance : defaultAcceptance()),
  )
  return {
    live: true,
    reply: parsed.reply || '按你这轮改了一版，看右边文档。',
    prd: {
      ...prev,
      oneLiner: message.trim() || prev.oneLiner,
      title: parsed.title?.trim() || prev.title || message.trim(),
      body: parsed.body?.trim() || prev.body,
      acceptance,
      confirmed: false,
      version: prev.version + 1,
    },
  }
}
