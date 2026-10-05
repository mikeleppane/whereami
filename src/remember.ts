import type { Headline } from './next'
import type { SpResult } from './superpowers'
import type { Docs, LastSeen, Note, Observed, TaskSnap } from './types'

export function snapshot(
  sp: SpResult,
  headline: Headline,
  source: string | undefined,
  seen: string,
): LastSeen {
  const tasks: Record<string, TaskSnap> = {}
  for (const item of sp.items) {
    const key = item.key.replace(/^Task /, '')
    const evidence = item.evidence[0]?.text ?? ''
    tasks[key] = {
      state: item.state,
      ...(item.reviewed === undefined ? {} : { reviewed: item.reviewed }),
      ...(item.fixRound === undefined ? {} : { fixRound: [item.fixRound[0], item.fixRound[1]] }),
      ...(item.parked === undefined ? {} : { parked: item.parked }),
      evidence,
    }
  }

  return {
    phase: headline.phase,
    tasks,
    allComplete: sp.allComplete,
    ledgerSeen: sp.ledgerSeen,
    ...(source === undefined ? {} : { source }),
    seen,
  }
}

export type RememberInput = {
  prev: Note | null
  prevInvalid: boolean
  id: string
  branch: string | null
  head: string | null
  isDefault: boolean
  hasOwnCommits: boolean
  docs: Docs
  planHeadings: string[] | null
  sp: SpResult | null
  headline: Headline
  sessionObserved: Observed[]
  source?: string
  now: Date
}

export type Remembered = { note: Note; finishedAt: number | null; notices: string[] }

function sameHeadings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((heading, index) => heading === right[index])
}

function mergeObserved(previous: Observed[], current: Observed[]): Observed[] {
  const merged: Observed[] = []
  for (const observation of [...previous, ...current]) {
    if (
      merged.some(
        (entry) =>
          entry.skill === observation.skill &&
          entry.doc === observation.doc &&
          entry.at === observation.at,
      )
    ) {
      continue
    }
    merged.push(observation)
  }
  return merged
}

export function remember(input: RememberInput, prevFinishedAt: number | null): Remembered {
  const previous = input.prev
  const note: Note = previous
    ? { ...previous, branches: [...previous.branches] }
    : {
        version: 1,
        id: input.id,
        branches: [],
        unlinked: [],
        tips: {},
        docs: {},
        planTasks: [],
        observed: [],
        last: null,
      }
  const notices: string[] = []
  if (input.prevInvalid) {
    notices.push("whereami's earlier record was unreadable; rebuilt from files and git")
  }

  const canAddBranch =
    input.branch !== null &&
    (!input.isDefault || !note.branches.some((branch) => branch !== input.branch))
  if (input.branch !== null && input.isDefault && !canAddBranch) {
    note.branches = note.branches.filter((branch) => branch !== input.branch)
  } else if (canAddBranch && input.branch !== null) {
    if (!note.branches.includes(input.branch)) note.branches.push(input.branch)
    note.unlinked = note.unlinked.filter((branch) => branch !== input.branch)
  }
  if (input.branch !== null && input.hasOwnCommits && input.head !== null) {
    note.tips = { ...note.tips, [input.branch]: input.head }
  }

  note.docs = { ...note.docs, ...input.docs }
  note.observed = mergeObserved(previous?.observed ?? [], input.sessionObserved)

  const headingsFrozen = note.planTasks.length > 0
  if (input.planHeadings !== null) {
    if (headingsFrozen) {
      if (!sameHeadings(note.planTasks, input.planHeadings)) {
        notices.push('plan edited since the build started')
      }
    } else if (input.sp?.ledgerSeen) {
      note.planTasks = [...input.planHeadings]
    }
  }

  const seen = input.now.toISOString()
  if (input.sp?.currentLedger) {
    note.last = snapshot(input.sp, input.headline, input.source, seen)
  } else if (note.last !== null) {
    note.last = { ...note.last, phase: input.headline.phase }
  }

  const finishedAt =
    prevFinishedAt ??
    (input.headline.phase === 'done' || input.headline.phase === 'merged'
      ? Math.floor(input.now.getTime() / 1000)
      : null)
  return { note, finishedAt, notices }
}
