import type { ItemStatus, LastSeen, ReadOutcome, ReaderResult } from './types'

export type PlanInfo = { tasks: { n: number; title: string }[]; spec?: string }
export type Ledger = { plan: string; lines: string[] }
export type SpInput = {
  planPath: string
  plan: PlanInfo | null
  ledger: ReadOutcome | null
  ledgerPath?: string
  // A recovered ledger may name its plan absolutely in a different worktree.
  ledgerRoot?: string
  repoRoot: string
  previous: LastSeen | null
  // null: the branch's commits are unknown (git failed or its output was cut), never none.
  taskCommits: number[] | null
  // Why the plan file could not be read (too big, not text, an error); a missing plan is `plan: null` alone.
  planUnreadable?: string
}
export type SpResult = ReaderResult & {
  allComplete: boolean
  ledgerSeen: boolean
  currentLedger: boolean
}

const NOT_LEDGER = 'not a Superpowers ledger'
const UNSUPPORTED_FILE = 'file over 1 MB or not text'

export function parsePlan(text: string): PlanInfo {
  const tasks: PlanInfo['tasks'] = []
  let spec: string | undefined
  let sawSpecLine = false

  for (const line of text.split(/\r?\n/)) {
    const task = /^### Task (\d+):\s*(.*)$/.exec(line)
    if (task) {
      const [, number = '', title = ''] = task
      tasks.push({ n: Number(number), title: title.trim() })
    }

    if (!sawSpecLine) {
      const specLine = /^\*\*Spec:\*\*\s*(.*)$/.exec(line)
      if (specLine) {
        sawSpecLine = true
        const body = specLine[1] ?? ''
        const backticked = /`([^`]+)`/.exec(body)
        const firstToken = body.trim().split(/\s+/)[0]
        spec = backticked?.[1] ?? firstToken
        if (spec === '') spec = undefined
      }
    }
  }

  return spec === undefined ? { tasks } : { tasks, spec }
}

export function parseLedger(text: string): Ledger | { unsupported: string } {
  const parts = text
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .split('\n')
  const match = /^# SDD ledger — plan: (.+)$/.exec(parts[0] ?? '')
  const plan = match?.[1]
  return plan === undefined ? { unsupported: NOT_LEDGER } : { plan, lines: parts.slice(1) }
}

export function repoRelative(path: string, repoRoot: string): string {
  const root = repoRoot.endsWith('/') ? repoRoot.slice(0, -1) : repoRoot
  const prefix = `${root}/`
  const relative = path.startsWith(prefix) ? path.slice(prefix.length) : path
  return relative.replace(/^\.\//, '')
}

function docsFor(input: SpInput): ReaderResult['docs'] {
  const docs: ReaderResult['docs'] = { plan: repoRelative(input.planPath, input.repoRoot) }
  if (input.plan?.spec) docs.spec = repoRelative(input.plan.spec, input.repoRoot)
  return docs
}

function planItems(input: SpInput, state: ItemStatus['state'] = 'open'): ItemStatus[] {
  if (!input.plan) return []
  const source = repoRelative(input.planPath, input.repoRoot)
  return input.plan.tasks.map(({ n, title }) => ({
    key: `Task ${n}`,
    title,
    kind: 'task',
    state,
    evidence: [{ strength: 'recorded', source, text: `### Task ${n}: ${title}` }],
  }))
}

function baseResult(input: SpInput, items: ItemStatus[], phase: ReaderResult['phase']): SpResult {
  const notes = input.plan?.tasks.length === 0 ? ['plan has no tasks'] : []
  return {
    library: 'superpowers',
    docs: docsFor(input),
    items,
    total: input.plan?.tasks.length,
    phase,
    weak: false,
    notes,
    allComplete: false,
    ledgerSeen: input.ledger !== null || input.previous?.ledgerSeen === true,
    currentLedger: false,
  }
}

function unsupported(input: SpInput, reason: string): SpResult {
  const phase = input.plan === null ? 'design' : 'unknown'
  return { ...baseResult(input, planItems(input, 'unknown'), phase), unsupported: reason }
}

type TaskUpdate = {
  n: number
  state: 'complete' | 'in-progress'
  text: string
  reviewed?: boolean
  fixRound?: [number, number]
  parked?: number
}

function statusLine(line: string): TaskUpdate | null {
  const complete = /^Task (\d+): complete \((.*)\)/.exec(line)
  if (complete) {
    const [, number = '', text = ''] = complete
    const parked = /(\d+) parked\b/.exec(text)
    const parkedCount = parked?.[1]
    return {
      n: Number(number),
      state: 'complete',
      text,
      ...(text.includes('review clean') ? { reviewed: true } : {}),
      ...(parkedCount === undefined ? {} : { parked: Number(parkedCount) }),
    }
  }

  const fixRound = /^Task (\d+): fix round (\d+)\/(\d+)(?: \((.*)\))?/.exec(line)
  if (!fixRound) return null
  const [, number = '', roundText = '', limitText = '', detail] = fixRound
  const round = Number(roundText)
  const limit = Number(limitText)
  return {
    n: Number(number),
    state: 'in-progress',
    text: detail ?? `fix round ${round}/${limit}`,
    fixRound: [round, limit],
  }
}

function withSnapshot(
  input: SpInput,
  previous: LastSeen,
  phase: 'done' | 'unknown',
  allComplete: boolean,
): SpResult {
  const source = previous.source ?? repoRelative(input.planPath, input.repoRoot)
  const items = Object.entries(previous.tasks).map(([key, snap]) => {
    const number = Number(key)
    const n = Number.isFinite(number) ? number : null
    const planned = n === null ? undefined : input.plan?.tasks.find((task) => task.n === n)
    return {
      key: n === null ? key : `Task ${n}`,
      title: planned?.title ?? (n === null ? key : `Task ${n}`),
      kind: 'task' as const,
      state: snap.state,
      ...(snap.reviewed === undefined ? {} : { reviewed: snap.reviewed }),
      ...(snap.fixRound === undefined ? {} : { fixRound: snap.fixRound }),
      ...(snap.parked === undefined ? {} : { parked: snap.parked }),
      evidence: [
        {
          strength: 'recorded' as const,
          source,
          text: `${snap.evidence} (from the progress file before it was removed)`,
        },
      ],
    }
  })
  const result = baseResult(input, items, phase)
  result.allComplete = allComplete
  return result
}

function readLedger(input: SpInput, ledger: Ledger): SpResult {
  if (!input.plan) return baseResult(input, [], 'design')

  const items = planItems(input)
  const itemByNumber = new Map(input.plan.tasks.map((task, i) => [task.n, items[i]]))
  const statusEvidence = new Map<number, ItemStatus['evidence']>()
  const notes = input.plan.tasks.length === 0 ? ['plan has no tasks'] : []
  const disagree = new Set<number>()

  const addEvidence = (n: number, item: ItemStatus, update: TaskUpdate, lineNumber: number) => {
    const evidence = {
      strength: 'recorded' as const,
      source: `${input.ledgerPath ?? 'ledger'}:${lineNumber}`,
      text: update.text,
    }
    const collected = [...(statusEvidence.get(n) ?? []), evidence]
    statusEvidence.set(n, collected)

    delete item.reviewed
    delete item.fixRound
    delete item.parked
    item.state = update.state
    item.evidence = collected
    if (update.reviewed !== undefined) item.reviewed = update.reviewed
    if (update.fixRound !== undefined) item.fixRound = update.fixRound
    if (update.parked !== undefined) item.parked = update.parked
  }

  ledger.lines.forEach((line, index) => {
    if (line.trim() === '') return

    const update = statusLine(line)
    if (update) {
      const item = itemByNumber.get(update.n)
      if (!item) {
        disagree.add(update.n)
        return
      }
      addEvidence(update.n, item, update, index + 2)
      return
    }

    const finding = /^Task (\d+):\s*(.*)$/.exec(line)
    if (finding) {
      const n = Number(finding[1])
      const item = itemByNumber.get(n)
      if (!item) {
        disagree.add(n)
        return
      }
      item.findings = [...(item.findings ?? []), line]
      return
    }

    const final = /^Final:\s*(.*)$/.exec(line)
    notes.push(final ? `final review: ${final[1]}` : line)
  })

  for (const n of disagree) notes.push(`plan and progress disagree: Task ${n}`)
  const allComplete =
    input.plan.tasks.length > 0 &&
    input.plan.tasks.every(({ n }) => itemByNumber.get(n)?.state === 'complete')
  const result = baseResult(input, items, allComplete ? 'review' : 'build')
  result.notes = notes
  result.allComplete = allComplete
  result.currentLedger = true
  return result
}

export function readSuperpowers(input: SpInput): SpResult {
  // An unreadable plan is no missing one: no design claim, and the saved snapshot is left as it was.
  if (input.planUnreadable !== undefined) {
    const reason = `plan ${repoRelative(input.planPath, input.repoRoot)}: unsupported format (${input.planUnreadable})`
    const result = baseResult(input, [], 'unknown')
    result.notes.push(reason)
    return { ...result, unsupported: reason }
  }
  if (input.ledger && !input.ledger.ok) return unsupported(input, UNSUPPORTED_FILE)

  let ledger: Ledger | null = null
  if (input.ledger?.ok) {
    const parsed = parseLedger(input.ledger.text)
    if ('unsupported' in parsed) return unsupported(input, parsed.unsupported)
    ledger = parsed
    if (
      repoRelative(ledger.plan, input.ledgerRoot ?? input.repoRoot) !==
      repoRelative(input.planPath, input.repoRoot)
    ) {
      return unsupported(input, 'ledger names another plan')
    }
  }

  if (!input.plan) return baseResult(input, [], 'design')
  if (input.plan.tasks.length === 0) return baseResult(input, [], 'unknown')
  if (ledger) return readLedger(input, ledger)

  const previous = input.previous
  if (previous?.allComplete) return withSnapshot(input, previous, 'done', true)
  if (previous?.ledgerSeen) {
    const result = withSnapshot(input, previous, 'unknown', false)
    result.notes.push('progress file removed before the build was seen to finish')
    return result
  }

  // No ledger seen: "no progress recorded", so a heading gives its task no state (spec section 5).
  if (input.taskCommits === null) {
    const result = baseResult(input, planItems(input, 'unknown'), 'plan')
    result.weak = true
    result.notes.push('commits unknown: git could not list this branch, so none can be ruled out')
    return result
  }
  if (input.taskCommits.length > 0) {
    const tasks = [...new Set(input.taskCommits)]
    const planned = new Map(input.plan.tasks.map((task) => [task.n, task]))
    const items = tasks.map((n) => ({
      key: `Task ${n}`,
      title: planned.get(n)?.title ?? `Task ${n}`,
      kind: 'task' as const,
      state: 'unknown' as const,
      evidence: [
        {
          strength: 'related' as const,
          source: 'commit',
          text: 'commit found, completion unknown',
        },
      ],
    }))
    const result = baseResult(input, items, 'build')
    result.weak = true
    return result
  }

  return baseResult(input, planItems(input, 'unknown'), 'plan')
}
