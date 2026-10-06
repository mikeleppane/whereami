import { hhmm } from './matt'
import type { MattResult } from './matt'
import type { SpResult } from './superpowers'
import type { ItemStatus, Phase, ReaderResult } from './types'

export type FeatureState = {
  id: string
  sp: SpResult | null
  matt: MattResult | null
  merged: boolean | 'unknown' | 'n/a'
  agentsRunning: number
  agentsBeforeClear: number
  buildSkill?: string
  implementSpecAt?: string
  // null: the branch's commits are unknown, so related task commits cannot be ruled out.
  taskCommitsWithoutLedger: number[] | null
}

export type Headline = {
  phase: Phase
  weak: boolean
  count?: [number, number]
  // Plan tasks while no ledger was ever seen: no progress recorded, neither zero nor done (spec section 5).
  planned?: number
  decisions?: [number, number]
  blocked: number
}

export type NextAction = { text: string; command?: string; missing?: string }

const FINISHED_TICKET_STATUSES = new Set(['done', 'resolved', 'closed'])

function chosenResult(s: FeatureState): ReaderResult | null {
  if (s.sp?.docs.plan !== undefined) return s.sp
  return s.matt ?? s.sp
}

export function phaseOf(s: FeatureState): Headline {
  const result = chosenResult(s)
  const phase =
    result?.phase === 'done' && s.merged === true ? 'merged' : (result?.phase ?? 'unknown')
  const complete = result?.items.filter(
    (item) => item.kind !== 'decision' && item.state === 'complete',
  ).length

  const unrecorded = result !== null && result === s.sp && !s.sp.ledgerSeen
  return {
    phase,
    weak: result?.weak ?? false,
    ...(result?.total === undefined
      ? {}
      : unrecorded
        ? { planned: result.total }
        : { count: [complete ?? 0, result.total] }),
    ...(s.matt?.decisions === undefined ? {} : { decisions: s.matt.decisions }),
    blocked: result?.items.filter((item) => item.state === 'blocked').length ?? 0,
  }
}

function commandAction(
  text: string,
  name: string,
  installed: Set<string>,
  args?: string,
): NextAction {
  if (!installed.has(name)) return { text, missing: name }
  return { text, command: `/${name}${args === undefined ? '' : ` ${args}`}` }
}

function taskRange(tasks: number[]): string {
  const sorted = [...tasks].sort((a, b) => a - b)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (first === undefined || last === undefined) return ''
  return first === last ? `Task ${first}` : `Task ${first}–${last}`
}

function frontierItems(matt: MattResult): ItemStatus[] {
  return matt.frontier
    .map((key) => matt.items.find((item) => item.key === key))
    .filter((item): item is ItemStatus => item !== undefined)
}

function wasWorked(item: ItemStatus): boolean {
  return item.evidence.some(
    (evidence) => evidence.strength === 'observed' || evidence.strength === 'related',
  )
}

function stillOpen(item: ItemStatus): boolean {
  return item.raw === undefined || !FINISHED_TICKET_STATUSES.has(item.raw.trim().toLowerCase())
}

function ticketNames(keys: string[], verb: string): string {
  return keys.map((key) => `ticket ${key} ${verb}`).join(', ')
}

export function nextAction(s: FeatureState, installed: Set<string>): NextAction | null {
  if (s.agentsBeforeClear > 0) {
    return { text: `wait: ${s.agentsBeforeClear} agents from before the clear are still running` }
  }

  if (
    s.sp?.docs.plan !== undefined &&
    !s.sp.ledgerSeen &&
    s.taskCommitsWithoutLedger !== null &&
    s.taskCommitsWithoutLedger.length > 0
  ) {
    return {
      text: `commits for ${taskRange(s.taskCommitsWithoutLedger)} found but no progress file: check before rebuilding`,
    }
  }

  if (s.implementSpecAt !== undefined && s.matt?.phase !== 'done') {
    // While its agents run they build the tickets: any suggestion would redo their work.
    if (s.agentsRunning > 0) return null
    return {
      text: `implement-spec started at ${hhmm(s.implementSpecAt)} and nothing is running: check its integration branch before rerunning`,
    }
  }

  // Not merged only on evidence: a squash merge is unknown, and default-branch work has no merged state
  // (spec section 5).
  if (s.sp?.phase === 'done' && s.merged === false) {
    return commandAction(
      'finish and merge this branch',
      'superpowers:finishing-a-development-branch',
      installed,
    )
  }

  if (s.sp?.phase === 'review' && s.agentsRunning === 0 && s.sp.docs.plan !== undefined) {
    const skill = s.buildSkill ?? 'superpowers:subagent-driven-development'
    return commandAction(
      'resume: it continues at the final review',
      skill,
      installed,
      s.sp.docs.plan,
    )
  }

  if (
    s.sp?.phase === 'build' &&
    s.sp.ledgerSeen &&
    s.agentsRunning === 0 &&
    s.sp.docs.plan !== undefined
  ) {
    const skill = s.buildSkill ?? 'superpowers:subagent-driven-development'
    return commandAction(
      'resume: it continues from the progress file',
      skill,
      installed,
      s.sp.docs.plan,
    )
  }

  if (
    s.sp?.phase === 'plan' &&
    !s.sp.ledgerSeen &&
    s.taskCommitsWithoutLedger?.length === 0 &&
    s.sp.docs.plan !== undefined
  ) {
    return commandAction(
      'build the plan',
      'superpowers:subagent-driven-development',
      installed,
      s.sp.docs.plan,
    )
  }

  if (s.sp?.phase === 'design' && s.sp.docs.spec !== undefined) {
    return commandAction(
      'turn the spec into a plan',
      'superpowers:writing-plans',
      installed,
      s.sp.docs.spec,
    )
  }

  // A mixed feature takes its phase from the plan (spec section 5): no Matt row drafts work for it.
  if (s.sp?.docs.plan !== undefined && s.matt !== null) return null

  const matt = s.matt
  if (
    matt?.phase === 'design' &&
    matt.docs.spec !== undefined &&
    matt.unreadableTickets === 0 &&
    !matt.items.some((item) => item.kind === 'ticket')
  ) {
    return commandAction(
      'turn the spec into tickets',
      'mattpocock-skills:to-tickets',
      installed,
      matt.docs.spec,
    )
  }

  if (
    matt?.docs.map !== undefined &&
    frontierItems(matt).some((item) => item.kind === 'decision')
  ) {
    return commandAction(
      'resolve the ready decisions',
      'mattpocock-skills:wayfinder',
      installed,
      matt.docs.map,
    )
  }

  const frontier = matt ? frontierItems(matt) : []
  const tickets = frontier.filter(
    (item) =>
      item.kind === 'ticket' &&
      item.state === 'open' &&
      item.path !== undefined &&
      !wasWorked(item),
  )
  const implementable = tickets.filter(
    (item) => !['ready-for-human', 'needs-triage'].includes(item.raw?.trim().toLowerCase() ?? ''),
  )

  if (implementable.length > 0) {
    const target = implementable[0]
    if (!target?.path) return null
    const builtHere = matt?.items.filter(
      (item) =>
        item.kind === 'ticket' &&
        item.state === 'complete' &&
        item.evidence.some((evidence) => evidence.strength === 'observed') &&
        stillOpen(item),
    )
    const text =
      builtHere && builtHere.length > 0
        ? `${builtHere.map((item) => item.key).join(', ')} built here, still open`
        : 'implement the next ready ticket'
    return commandAction(text, 'mattpocock-skills:implement', installed, target.path)
  }

  if (
    tickets.length > 0 &&
    tickets.every((item) => item.raw?.trim().toLowerCase() === 'ready-for-human')
  ) {
    return {
      text: ticketNames(
        tickets.map((item) => item.key),
        'is marked for a human',
      ),
    }
  }

  if (
    tickets.length > 0 &&
    tickets.every((item) => item.raw?.trim().toLowerCase() === 'needs-triage')
  ) {
    return commandAction(
      ticketNames(
        tickets.map((item) => item.key),
        'needs triage',
      ),
      'mattpocock-skills:triage',
      installed,
    )
  }

  if (
    matt?.phase === 'design' &&
    matt.docs.spec !== undefined &&
    matt.unreadableTickets > 0 &&
    !matt.items.some((item) => item.kind === 'ticket')
  ) {
    return { text: 'cannot determine the next action: a ticket could not be read' }
  }

  if (s.sp === null && matt?.phase === 'done' && s.merged === false) {
    return commandAction('writes the pull request body', 'mattpocock-skills:pr', installed)
  }

  const hasMattInstalled = [...installed].some((name) => name.startsWith('mattpocock-skills:'))
  const hasSuperpowersInstalled = [...installed].some((name) => name.startsWith('superpowers:'))
  if (matt !== null || (hasMattInstalled && !hasSuperpowersInstalled)) {
    return commandAction(
      "not sure what's next: ask Matt's guide",
      'mattpocock-skills:ask-matt',
      installed,
    )
  }

  return null
}
