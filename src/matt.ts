import type { Evidence, ItemState, ItemStatus, Observed, ReaderResult } from './types'

export type Ticket = {
  key: string
  slug: string
  title: string
  path: string
  status?: string
  blockedBy: string[]
  type?: string
}

export type MattInput = {
  folder: string
  hasSpec: boolean
  hasMap: boolean
  // null: git could not tell which tickets exist; the inventory is unknown, never empty.
  tickets: (Ticket & { differsOn?: string[] })[] | null
  // branch: only that branch's comparison copy could not be read; without it, the ticket itself could not.
  unreadable: { path: string; why: string; branch?: string }[]
  // commitsSince null: git could not count the commits after that start.
  observed: (Observed & { commitsSince: number | null })[]
  // null: the branch's commits are unknown, so no ticket can be shown unworked.
  relatedKeys: string[] | null
}

export type MattResult = ReaderResult & {
  frontier: string[]
  decisions?: [number, number]
  unreadableTickets: number
}

type TicketWork = {
  ticket: Ticket & { differsOn?: string[] }
  blockers: { token: string; target?: Ticket }[]
  cycle: boolean
  observed?: Observed & { commitsSince: number | null }
  related: boolean
}

const OPEN_STATUSES = new Set(['ready-for-agent', 'ready-for-human', 'needs-triage'])
const COMPLETE_STATUSES = new Set(['done', 'resolved', 'closed'])

function parseField(line: string, name: string): string | undefined {
  const match = new RegExp(`^\\s*(?:\\*\\*${name}:\\*\\*|${name}:)\\s*(.*?)\\s*$`, 'i').exec(line)
  return match?.[1]?.trim()
}

function pathParts(path: string): { key: string; slug: string } {
  const filename = path.slice(path.lastIndexOf('/') + 1)
  const withoutExtension = filename.endsWith('.md') ? filename.slice(0, -3) : filename
  const key = /^(\d+)/.exec(withoutExtension)?.[1] ?? ''
  const slug = withoutExtension.slice(key.length).replace(/^-/, '')
  return { key, slug }
}

function parseBlockers(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '' || /^none\b/i.test(value.trim())) return []
  return value
    .split(',')
    .map((token) => token.replace(/[#'"]/g, '').trim())
    .filter((token) => token !== '')
}

export function parseTicket(path: string, text: string): Ticket {
  const { key, slug } = pathParts(path)
  let title: string | undefined
  let status: string | undefined
  let blockedBy: string | undefined
  let type: string | undefined

  for (const line of text.split(/\r?\n/)) {
    if (title === undefined && line.startsWith('# ')) title = line.slice(2).trim()
    status ??= parseField(line, 'Status')
    blockedBy ??= parseField(line, 'Blocked by')
    type ??= parseField(line, 'Type')
  }

  return {
    key,
    slug,
    title: title || slug,
    path,
    ...(status === undefined ? {} : { status }),
    blockedBy: parseBlockers(blockedBy),
    ...(type === undefined || type === '' ? {} : { type }),
  }
}

export function hhmm(iso: string): string {
  const date = new Date(iso)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function resolveBlocker(
  token: string,
  tickets: (Ticket & { differsOn?: string[] })[],
): (Ticket & { differsOn?: string[] }) | undefined {
  const value = normalize(token)
  return tickets.find(
    (ticket) =>
      normalize(ticket.key) === value ||
      normalize(`${ticket.key}-${ticket.slug}`) === value ||
      normalize(ticket.title) === value,
  )
}

function findCycles(works: TicketWork[]): Set<Ticket> {
  const workByTicket = new Map(works.map((work) => [work.ticket, work]))
  const indices = new Map<Ticket, number>()
  const lowLinks = new Map<Ticket, number>()
  const stack: Ticket[] = []
  const onStack = new Set<Ticket>()
  const cycles = new Set<Ticket>()
  let nextIndex = 0

  const visit = (ticket: Ticket) => {
    const index = nextIndex++
    indices.set(ticket, index)
    lowLinks.set(ticket, index)
    stack.push(ticket)
    onStack.add(ticket)

    for (const { target } of workByTicket.get(ticket)?.blockers ?? []) {
      if (target === undefined) continue
      if (!indices.has(target)) {
        visit(target)
        lowLinks.set(ticket, Math.min(lowLinks.get(ticket) ?? index, lowLinks.get(target) ?? index))
      } else if (onStack.has(target)) {
        lowLinks.set(ticket, Math.min(lowLinks.get(ticket) ?? index, indices.get(target) ?? index))
      }
    }

    if (lowLinks.get(ticket) !== index) return

    const component: Ticket[] = []
    let member = stack.pop()
    while (member !== undefined) {
      onStack.delete(member)
      component.push(member)
      if (member === ticket) break
      member = stack.pop()
    }

    const selfLoop = workByTicket.get(ticket)?.blockers.some((blocker) => blocker.target === ticket)
    if (component.length > 1 || selfLoop) {
      for (const participant of component) cycles.add(participant)
    }
  }

  for (const work of works) {
    if (!indices.has(work.ticket)) visit(work.ticket)
  }
  return cycles
}

function rawState(ticket: Ticket): ItemState {
  const status = ticket.status === undefined ? undefined : normalize(ticket.status)
  if (status === 'wontfix') return 'dropped'
  if (status !== undefined && COMPLETE_STATUSES.has(status)) return 'complete'
  if (status === 'needs-info') return 'blocked'
  if (status === 'claimed') return 'in-progress'
  if (status !== undefined && OPEN_STATUSES.has(status)) return 'open'
  return ticket.type && status === undefined ? 'open' : 'unknown'
}

function observedText(observation: Observed & { commitsSince: number | null }): string {
  const time = hhmm(observation.at)
  if (observation.commitsSince === null)
    return `implement started at ${time}, commits since unknown`
  if (observation.commitsSince >= 1) {
    return `built here at ${time}, ${observation.commitsSince} commits, ticket still open`
  }
  return `implement started at ${time}, 0 commits, ticket still open`
}

function itemFor(work: TicketWork, incompleteBlockers: Ticket[]): ItemStatus {
  const { ticket } = work
  const observed = work.observed ? observedText(work.observed) : undefined
  const hasRecordedCompletion =
    ticket.status !== undefined && COMPLETE_STATUSES.has(normalize(ticket.status))
  const status = rawState(ticket)

  // undefined: not observed; null: observed, but git could not count the commits since.
  const since = work.observed?.commitsSince
  let state = status
  let waitingOn: string[] | undefined

  if (status !== 'dropped' && !hasRecordedCompletion && status !== 'blocked') {
    if (work.cycle || work.blockers.some((blocker) => blocker.target === undefined)) {
      state = 'unknown'
    } else if (since === null) {
      state = 'unknown'
    } else if (since !== undefined && since >= 1) {
      state = 'complete'
    } else if (incompleteBlockers.length > 0) {
      state = 'waiting'
      waitingOn = incompleteBlockers.map((blocker) => blocker.key)
    } else if (observed) {
      state = 'in-progress'
    }
  }

  const evidence: Evidence[] = []
  if (work.observed && observed) {
    evidence.push({
      strength: 'observed',
      source: `seen ${hhmm(work.observed.at)}`,
      text: observed,
    })
  }
  if (ticket.status !== undefined) {
    evidence.push({ strength: 'recorded', source: ticket.path, text: `Status: ${ticket.status}` })
  }
  if (ticket.type !== undefined) {
    evidence.push({ strength: 'recorded', source: ticket.path, text: `Type: ${ticket.type}` })
  }
  if (ticket.blockedBy.length > 0) {
    evidence.push({
      strength: 'recorded',
      source: ticket.path,
      text: `Blocked by: ${ticket.blockedBy.join(', ')}`,
    })
  }
  if (work.related) {
    evidence.push({
      strength: 'related',
      source: 'commit',
      text: 'commit found, completion unknown',
    })
  }

  return {
    key: ticket.key,
    title: ticket.title,
    kind: ticket.type ? 'decision' : 'ticket',
    state,
    ...(ticket.status === undefined ? {} : { raw: ticket.status }),
    path: ticket.path,
    ...(ticket.type === undefined ? {} : { type: ticket.type }),
    ...(ticket.differsOn === undefined ? {} : { differsOn: ticket.differsOn }),
    ...(waitingOn === undefined ? {} : { waitingOn }),
    evidence,
  }
}

function byKey(a: ItemStatus, b: ItemStatus): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

export function readMatt(input: MattInput): MattResult {
  const tickets = input.tickets ?? []
  const works: TicketWork[] = tickets.map((ticket) => ({
    ticket,
    blockers: ticket.blockedBy.map((token) => ({
      token,
      target: resolveBlocker(token, tickets),
    })),
    cycle: false,
    observed: input.observed.find(
      (observation) =>
        observation.skill === 'mattpocock-skills:implement' && observation.doc === ticket.path,
    ),
    related: input.relatedKeys?.includes(ticket.key) ?? false,
  }))
  const cycles = findCycles(works)
  for (const work of works) work.cycle = cycles.has(work.ticket)

  const notes = input.unreadable.map(
    ({ path, why, branch }) =>
      `ticket ${path}: unsupported format (${why}${branch === undefined ? '' : ` on ${branch}`})`,
  )
  // A ticket that could not be read may be open: nothing is complete until every ticket's state is known.
  const allRead = input.unreadable.every((u) => u.branch !== undefined)
  for (const work of works) {
    for (const blocker of work.blockers) {
      if (blocker.target === undefined) {
        notes.push(`ticket ${work.ticket.key}: blocker "${blocker.token}" matches no ticket`)
      }
    }
    if (work.cycle) notes.push(`ticket ${work.ticket.key}: blocker cycle`)
  }

  const baseline = new Map(
    works.map((work) => {
      const state = rawState(work.ticket)
      const invalidBlocker =
        work.cycle || work.blockers.some((blocker) => blocker.target === undefined)
      const since = work.observed?.commitsSince
      const observedComplete = since !== undefined && since !== null && since >= 1
      const effectiveState =
        state === 'dropped' || state === 'complete' || state === 'blocked'
          ? state
          : invalidBlocker
            ? 'unknown'
            : observedComplete
              ? 'complete'
              : state
      return [work.ticket, effectiveState]
    }),
  )
  const items = works.map((work) => {
    const incompleteBlockers = work.blockers
      .map((blocker) => blocker.target)
      .filter(
        (target): target is Ticket => target !== undefined && baseline.get(target) !== 'complete',
      )
    return itemFor(work, incompleteBlockers)
  })
  const itemByTicket = new Map(works.map((work, index) => [work.ticket, items[index]]))

  const decisions = works.filter((work) => work.ticket.type !== undefined)
  const countedDecisions = decisions.filter(
    (work) => normalize(work.ticket.status ?? '') !== 'wontfix',
  )
  const buildWorks = works.filter((work) => work.ticket.type === undefined)
  const countedBuildWorks = buildWorks.filter(
    (work) => normalize(work.ticket.status ?? '') !== 'wontfix',
  )
  const decisionItems = decisions
    .map((work) => itemByTicket.get(work.ticket))
    .filter((item): item is ItemStatus => item !== undefined)
  const buildItems = buildWorks
    .map((work) => itemByTicket.get(work.ticket))
    .filter((item): item is ItemStatus => item !== undefined)
  const countedBuildItems = countedBuildWorks
    .map((work) => itemByTicket.get(work.ticket))
    .filter((item): item is ItemStatus => item !== undefined)

  const frontierSource = buildWorks.length > 0 ? buildItems : decisionItems
  const frontier = (input.relatedKeys === null ? [] : frontierSource)
    .filter(
      (item) =>
        item.state === 'open' &&
        !item.evidence.some(
          (evidence) => evidence.strength === 'observed' || evidence.strength === 'related',
        ),
    )
    .sort(byKey)
    .map((item) => item.key)

  // Every counted build ticket recorded complete: implement-spec's final step has run, so an earlier start no
  // longer marks the build pending.
  const recordedDone =
    allRead &&
    countedBuildWorks.length > 0 &&
    countedBuildWorks.every((work) => COMPLETE_STATUSES.has(normalize(work.ticket.status ?? '')))
  const implementSpec = recordedDone
    ? undefined
    : input.observed.find(
        (observation) =>
          observation.skill === 'mattpocock-skills:implement-spec' &&
          observation.doc === `${input.folder}/spec.md`,
      )
  if (input.tickets === null) notes.push('tickets unknown: git could not tell which exist')
  if (input.relatedKeys === null)
    notes.push('commits unknown: no ticket is suggested, as any may have work committed')
  if (implementSpec) {
    notes.push(
      `implement-spec started ${hhmm(implementSpec.at)}; ticket statuses update at its end`,
    )
  }

  let phase: ReaderResult['phase']
  if (input.tickets === null) {
    phase = 'unknown'
  } else if (implementSpec) {
    phase = 'build'
  } else if (countedBuildItems.length === 0) {
    phase = input.hasSpec || input.hasMap ? 'design' : 'unknown'
  } else if (allRead && countedBuildItems.every((item) => item.state === 'complete')) {
    phase = 'done'
  } else if (
    countedBuildItems.every(
      (item) =>
        item.state !== 'complete' &&
        item.state !== 'in-progress' &&
        !item.evidence.some(
          (evidence) => evidence.strength === 'observed' || evidence.strength === 'related',
        ),
    )
  ) {
    phase = 'plan'
  } else {
    phase = 'build'
  }

  const resolvedDecisions = decisions.filter((work) =>
    ['resolved', 'closed'].includes(normalize(work.ticket.status ?? '')),
  ).length
  const weak =
    items.some((item) =>
      item.evidence.some(
        (evidence) => evidence.strength === 'observed' || evidence.strength === 'related',
      ),
    ) ||
    implementSpec !== undefined ||
    !allRead ||
    input.tickets === null ||
    input.relatedKeys === null

  return {
    library: 'matt',
    docs: {
      ...(input.hasSpec ? { spec: `${input.folder}/spec.md` } : {}),
      ...(input.hasMap ? { map: `${input.folder}/map.md` } : {}),
      ...(input.tickets === null || tickets.length > 0 || input.unreadable.length > 0
        ? { tickets: `${input.folder}/issues/` }
        : {}),
    },
    items,
    ...(input.tickets === null ? {} : { total: countedBuildItems.length }),
    phase,
    weak,
    notes,
    frontier,
    unreadableTickets: input.unreadable.length,
    ...(decisions.length === 0 ? {} : { decisions: [resolvedDecisions, countedDecisions.length] }),
  }
}
