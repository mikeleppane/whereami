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
  // Snapshot provenance, independent of the note's current documents. Legacy notes may omit it.
  plan?: string
  // Absolute source in the original worktree. Legacy relative sources cannot establish removal.
  source?: string
  // Worktree root used to normalize an absolute plan path in the source ledger's header.
  sourceRoot?: string
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
  // null: a successful listing found no main checkout (including a bare repo); undefined: discovery failed.
  // A refresh needing that fallback must keep the ticket inventory unknown, never substitute an empty one.
  mainRoot: string | null | undefined
  // branch and defaultBranch are hook-parity display/key names, not branch identities.
  branch: string | null
  // Full symbolic HEAD target. Strip refs/heads/ for note identities; use the full ref for revisions.
  // null: confirmed detached HEAD; undefined: discovery failed or was truncated. Task 14 must not treat
  // undefined as detached or replace an unknown buildBranch result with the default branch or HEAD.
  branchRef: string | null | undefined
  head: string | null
  defaultBranch: string | null
  // Canonical default identity from the full origin/HEAD target, else a confirmed main/master probe.
  // null: confirmed no default; undefined: identity discovery unknown. Task 14 uses this for exclusions
  // and default-branch decisions, never defaultBranch (display only) or a name derived from defaultRef.
  defaultName: string | null | undefined
  // defaultRef: the default branch as a full ref for revision arguments (`refs/heads/<b>`, else
  // `refs/remotes/origin/<b>`), from origin/HEAD's full target; null when none exists or git cannot tell.
  // A null ref does not erase defaultName: identity can be known even when the usable revision is not.
  defaultRef: string | null
}
