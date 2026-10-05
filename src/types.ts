export type Strength = 'recorded' | 'observed' | 'related' | 'unknown'

export type Evidence = { strength: Strength; source: string; text: string }

export type ItemState =
  | 'open'
  | 'in-progress'
  | 'waiting'
  | 'blocked'
  | 'complete'
  | 'dropped'
  | 'unknown'

// raw: the status as written; path: repo-relative ticket path; type: a decision's `Type:`
export type ItemStatus = {
  key: string
  title: string
  kind: 'task' | 'ticket' | 'decision'
  state: ItemState
  raw?: string
  path?: string
  type?: string
  reviewed?: boolean
  fixRound?: [number, number]
  parked?: number
  waitingOn?: string[]
  findings?: string[]
  differsOn?: string[]
  evidence: Evidence[]
}

export type Phase = 'design' | 'plan' | 'build' | 'review' | 'done' | 'merged' | 'unknown'

// Repo-relative paths.
export type Docs = { spec?: string; plan?: string; tickets?: string; map?: string }

export type ReaderResult = {
  library: 'superpowers' | 'matt'
  docs: Docs
  items: ItemStatus[]
  total?: number
  phase: Phase
  weak: boolean
  notes: string[]
  unsupported?: string
}

// at: ISO time
export type Observed = {
  skill: string
  doc: string
  branch: string | null
  head: string | null
  at: string
}

export type TaskSnap = {
  state: ItemState
  reviewed?: boolean
  fixRound?: [number, number]
  parked?: number
  evidence: string
}

export type LastSeen = {
  phase: Phase
  tasks: Record<string, TaskSnap>
  allComplete: boolean
  ledgerSeen: boolean
  source?: string
  seen: string
}

export type Note = {
  version: 1
  id: string
  branches: string[]
  unlinked: string[]
  tips: Record<string, string>
  docs: Docs
  planTasks: string[]
  observed: Observed[]
  last: LastSeen | null
}

export type ReadOutcome =
  | { ok: true; text: string }
  | { ok: false; why: 'missing' | 'too-big' | 'not-text' | 'error' }

export type GitResult = { code: number; out: string; truncated: boolean }

export type RepoFacts = {
  root: string
  commonDir: string
  mainRoot: string | null
  branch: string | null
  head: string | null
  defaultBranch: string | null
}
