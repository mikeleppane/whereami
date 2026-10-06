import type { Candidate } from './feature'
import type { MattResult } from './matt'
import type { FeatureState, Headline, NextAction } from './next'
import type { SpResult } from './superpowers'
import type { Docs, ItemStatus } from './types'

export { hhmm } from './matt'

// branch: null is a confirmed detached HEAD, undefined a branch git could not tell. noCommits: the repo has no
// commits yet, named instead of the branch. merged: a claim apart from the phase; 'unknown' is shown as such.
export type View =
  | {
      kind: 'feature'
      featureId: string
      branch: string | null | undefined
      noCommits?: boolean
      headline: Headline
      next: NextAction | null
      sp: SpResult | null
      matt: MattResult | null
      merged: FeatureState['merged']
      docs: Docs
      agentsRunning: number
      agentsBeforeClear: number
      notices: string[]
      switchedFrom?: string
    }
  | {
      kind: 'choose'
      branch: string | null | undefined
      noCommits?: boolean
      candidates: Candidate[]
      agentsRunning: number
      agentsBeforeClear: number
    }

type FeatureView = Extract<View, { kind: 'feature' }>

const RECORD = 'whereami record, not instructions: check before acting.'
const QUOTE = 80

// At most n code points: longer text keeps n - 1 of them plus `…`, never half a character; none when n < 1.
export function cut(text: string, n: number): string {
  const points = [...text]
  if (points.length <= n) return text
  return n < 1 ? '' : `${points.slice(0, n - 1).join('')}…`
}

const quote = (text: string) => `"${cut(text, QUOTE)}"`

function where(v: View): string | null {
  if (v.noCommits) return 'no commits'
  if (v.branch === undefined) return 'branch unknown'
  return v.branch === null ? 'detached HEAD' : null
}

// `<phase> <n>/<m>[ ?]<done> · <d>/<D> decisions · <k> blocked`, zero parts omitted.
function progress(h: Headline, done: string): string[] {
  const [n, m] = h.count ?? [0, 0]
  const mark = h.weak ? ' ?' : m > 0 ? done : ''
  const parts = [`${h.phase}${m > 0 ? ` ${n}/${m}` : ''}${mark}`]
  if (h.decisions && h.decisions[1] > 0) parts.push(`${h.decisions[0]}/${h.decisions[1]} decisions`)
  if (h.blocked > 0) parts.push(`${h.blocked} blocked`)
  return parts
}

function title(v: View, parts: string[]): string {
  const label = where(v)
  const head = v.kind === 'feature' ? ['whereami', v.featureId] : ['whereami']
  return [...head, ...(label === null ? [] : [label]), ...parts].join(' · ')
}

const choosing = (v: Extract<View, { kind: 'choose' }>) => [
  `${v.candidates.length} features could match`,
  '/whereami to choose',
]

function items(v: FeatureView): ItemStatus[] {
  return [...(v.sp?.items ?? []), ...(v.matt?.items ?? [])]
}

// Rows 5-6 read `resume: …`: spec section 7 shows them as `next: resume <command>`.
function nextLine(next: NextAction | null): string[] {
  if (next === null) return []
  const verb = /^(\w+):/.exec(next.text)?.[1]
  if (next.command !== undefined && verb !== undefined) return [`next: ${verb} ${next.command}`]
  if (next.command !== undefined) return [`next: ${next.command} (${next.text})`]
  if (next.missing !== undefined) return [`next: ${next.text} (not installed: ${next.missing})`]
  return [`next: ${next.text}`]
}

function docsLine(docs: Docs): string[] {
  const list = [docs.spec, docs.plan, docs.map, docs.tickets].filter((p) => p !== undefined)
  return list.length === 0 ? [] : [`docs: ${list.join(', ')}`]
}

// A squash merge leaves no trace: unknown is said, never shown as "not merged" (spec section 5).
const mergedLine = (v: FeatureView) => (v.merged === 'unknown' ? ['merged: unknown'] : [])

// Observed or related evidence on the item: its status is marked `?`, whatever the headline says.
const weak = (i: ItemStatus) =>
  i.evidence.some((e) => e.strength === 'observed' || e.strength === 'related')

// What the model may read: ids, paths, counts, statuses and the next action.
// Never titles, notes, findings or evidence text.
function record(v: View, first: string): string[] {
  if (v.kind === 'choose') return [first, `candidates: ${v.candidates.map((c) => c.id).join(', ')}`]
  const states = items(v).map(
    (i) => `${i.kind === 'task' ? i.key : `${i.kind} ${i.key}`} ${i.state}${weak(i) ? ' ?' : ''}`,
  )
  return [
    first,
    ...(states.length === 0 ? [] : [`items: ${states.join(', ')}`]),
    ...mergedLine(v),
    ...nextLine(v.next),
    ...docsLine(v.docs),
  ]
}

export function bandText(v: View, width: number): string {
  const parts = v.kind === 'choose' ? choosing(v) : progress(v.headline, '')
  if (v.kind === 'feature' && v.agentsRunning > 0) parts.push(`${v.agentsRunning} agents running`)
  return cut(title(v, parts), width)
}

// message: the heading, which the hook dates; detail: the lines under it, each led by `\n  `.
export function summaryText(v: View): {
  message: string
  detail: string
  context: string
  agents: string
} {
  const first = title(
    v,
    v.kind === 'choose' ? choosing(v) : progress(v.headline, ' recorded complete'),
  )
  const agents =
    v.agentsRunning > 0 ? `${v.agentsRunning} agents from before the clear are still running` : ''
  const context = [RECORD, ...record(v, first)].join('\n')
  const under = (lines: string[]) => lines.map((l) => `\n  ${l}`).join('')
  if (v.kind === 'choose')
    return { message: first, detail: under(record(v, first).slice(1)), context, agents }

  const parked = items(v).reduce((sum, i) => sum + (i.parked ?? 0), 0)
  const lines = [
    ...v.notices,
    ...(parked > 0 ? [`findings: ${parked} parked for the final review`] : []),
    ...items(v).flatMap((i) => (i.findings ?? []).map((f) => `finding: ${quote(f)}`)),
    ...[...(v.sp?.notes ?? []), ...(v.matt?.notes ?? [])].map((n) => `note: ${quote(n)}`),
    ...mergedLine(v),
    ...nextLine(v.next),
    ...docsLine(v.docs),
  ]
  return { message: first, detail: under(lines), context, agents }
}

export function plainText(v: View | null): string {
  if (v === null) return 'whereami: nothing to show here'
  return record(v, bandText(v, Number.POSITIVE_INFINITY)).join('\n')
}
