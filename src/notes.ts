import { jsonString, keyOf } from './keys'
import type { Docs, LastSeen, Note, Observed, TaskSnap } from './types'

// whereami's folder in the git common dir; spec section 3.
export function paths(commonDir: string) {
  const root = `${commonDir}/whereami`
  return {
    root,
    feature: (id: string) => `${root}/features/${keyOf(id)}`,
    branch: (name: string | null, topLevel: string) =>
      `${root}/branches/${name === null ? `detached-${keyOf(topLevel)}` : keyOf(name)}`,
  }
}

// seen: epoch seconds. name: the branch, or for a detached HEAD the worktree top-level path.
export type BranchSummary = {
  featureId: string
  name: string
  seen: number
  message: string
  detail: string
  context: string
  agents: string
  watch: string[]
}

const lines = (items: string[]) => `${items.join('\n')}\n`
const printed = (text: string) => `${jsonString(text)}\n.\n`

// The files hooks/session-start.sh reads; `seen` last, so a watched file written before it never reads as newer.
export function branchFiles(
  s: BranchSummary,
): Record<
  'feature' | 'name' | 'seen' | 'message' | 'detail' | 'context' | 'agents' | 'watch',
  string
> {
  return {
    feature: `${s.featureId}\n`,
    name: `${s.name}\n`,
    message: printed(s.message),
    detail: s.detail === '' ? '' : printed(s.detail),
    context: printed(s.context),
    agents: s.agents === '' ? '' : printed(s.agents),
    watch: lines(s.watch),
    seen: `${Math.floor(s.seen)}\n`,
  }
}

export function featureFiles(
  note: Note,
  finishedAt: number | null,
): Record<'note.json' | 'branches' | 'finished', string> {
  return {
    'note.json': serializeNote(note),
    branches: lines(note.branches),
    finished: finishedAt === null ? '' : `${Math.floor(finishedAt)}\n`,
  }
}

export function serializeNote(note: Note): string {
  return `${JSON.stringify(note, null, 2)}\n`
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number'
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const opt = (v: unknown, is: (v: unknown) => boolean) => v === undefined || is(v)
// A field left out takes its default; one present, null included, is checked as it stands.
const missing = (v: unknown, d: unknown) => (v === undefined ? d : v)
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr)
const record = <T>(v: unknown, is: (v: unknown) => v is T): v is Record<string, T> =>
  isObj(v) && Object.values(v).every(is)

const PHASES = ['design', 'plan', 'build', 'review', 'done', 'merged', 'unknown']
const STATES = ['open', 'in-progress', 'waiting', 'blocked', 'complete', 'dropped', 'unknown']

const isDocs = (v: unknown): v is Docs => record(v, isStr)

const isObserved = (v: unknown): v is Observed =>
  isObj(v) &&
  isStr(v.skill) &&
  isStr(v.doc) &&
  isStr(v.at) &&
  (v.branch === null || isStr(v.branch)) &&
  (v.head === null || isStr(v.head))

const isTaskSnap = (v: unknown): v is TaskSnap =>
  isObj(v) &&
  STATES.includes(v.state as string) &&
  isStr(v.evidence) &&
  opt(v.reviewed, isBool) &&
  opt(v.parked, isNum) &&
  opt(v.fixRound, (r) => Array.isArray(r) && r.length === 2 && r.every(isNum))

const isLastSeen = (v: unknown): v is LastSeen =>
  isObj(v) &&
  PHASES.includes(v.phase as string) &&
  record(v.tasks, isTaskSnap) &&
  isBool(v.allComplete) &&
  isBool(v.ledgerSeen) &&
  opt(v.source, isStr) &&
  isStr(v.seen)

// A note.json as written by serializeNote, or null when it is not one (spec section 3: then it is rebuilt).
export function parseNote(text: string): Note | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObj(v) || v.version !== 1 || !isStr(v.id)) return null
  const note = {
    version: 1 as const,
    id: v.id,
    branches: missing(v.branches, []),
    unlinked: missing(v.unlinked, []),
    tips: missing(v.tips, {}),
    docs: missing(v.docs, {}),
    planTasks: missing(v.planTasks, []),
    observed: missing(v.observed, []),
    last: missing(v.last, null),
  }
  const ok =
    strs(note.branches) &&
    strs(note.unlinked) &&
    strs(note.planTasks) &&
    record(note.tips, isStr) &&
    isDocs(note.docs) &&
    Array.isArray(note.observed) &&
    note.observed.every(isObserved) &&
    (note.last === null || isLastSeen(note.last))
  return ok ? (note as Note) : null
}
