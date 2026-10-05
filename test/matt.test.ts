import { expect, test } from 'claude-code/testing'
import { hhmm, parseTicket, readMatt } from '../src/matt'
import type { MattInput, MattResult, Ticket } from '../src/matt'
import { BOLD_READY_TICKET, PLAIN_CLAIMED_TICKET, TITLE_BLOCKED_TICKET } from './fixtures/matt'

const ticket = (value: {
  key: string
  slug: string
  title: string
  status?: string
  blockedBy?: string[]
  type?: string
  differsOn?: string[]
}): Ticket & { differsOn?: string[] } => ({
  ...value,
  path: `.scratch/demo/issues/${value.key}-${value.slug}.md`,
  blockedBy: value.blockedBy ?? [],
})

const makeInput = (tickets: Ticket[], overrides: Partial<MattInput> = {}): MattInput => ({
  folder: '.scratch/demo',
  hasSpec: false,
  hasMap: false,
  tickets,
  unreadable: [],
  observed: [],
  relatedKeys: [],
  ...overrides,
})

const item = (result: MattResult, key: string) =>
  result.items.find((candidate) => candidate.key === key)

test('parseTicket reads bold and plain fields and falls back to the filename slug for its title', () => {
  const boldPath = '.scratch/demo/issues/01-token-store.md'
  const plainPath = '.scratch/demo/issues/02-cache.md'

  expect(parseTicket(boldPath, BOLD_READY_TICKET)).toEqual({
    key: '01',
    slug: 'token-store',
    title: 'Add token store',
    path: boldPath,
    status: 'ready-for-agent',
    blockedBy: [],
  })
  expect(parseTicket(plainPath, PLAIN_CLAIMED_TICKET)).toEqual({
    key: '02',
    slug: 'cache',
    title: 'cache',
    path: plainPath,
    status: 'claimed',
    blockedBy: [],
    type: 'task',
  })
})

test('parseTicket treats blockers starting with None as empty and strips hashes and quotes from tokens', () => {
  const path = '.scratch/demo/issues/03-store.md'
  const none = parseTicket(path, 'Blocked by: None (can start immediately)')
  const listed = parseTicket(path, 'Blocked by: #01, "#02", 03-store')
  const title = parseTicket(path, TITLE_BLOCKED_TICKET)

  expect(none.blockedBy).toEqual([])
  expect(listed.blockedBy).toEqual(['01', '02', '03-store'])
  expect(title.blockedBy).toEqual(['Add token store'])
})

test('readMatt resolves key, slug-key, and title blockers before exposing the frontier', () => {
  const result = readMatt(
    makeInput([
      ticket({
        key: '01',
        slug: 'token-store',
        title: 'Add token store',
        status: 'ready-for-agent',
      }),
      ticket({
        key: '02',
        slug: 'refresh',
        title: 'Refresh on 401',
        status: 'ready-for-agent',
        blockedBy: ['01'],
      }),
      ticket({
        key: '03',
        slug: 'cache',
        title: 'Cache the result',
        status: 'ready-for-agent',
        blockedBy: ['01-token-store'],
      }),
      ticket({
        key: '04',
        slug: 'retry',
        title: 'Retry on failure',
        status: 'ready-for-agent',
        blockedBy: ['Add Token Store'],
      }),
    ]),
  )

  expect(result.frontier).toEqual(['01'])
  expect(item(result, '02')?.state).toBe('waiting')
  expect(item(result, '02')?.waitingOn).toEqual(['01'])
  expect(item(result, '03')?.waitingOn).toEqual(['01'])
  expect(item(result, '04')?.waitingOn).toEqual(['01'])
})

test('a recorded completion stays complete when one of its blockers is still open', () => {
  const result = readMatt(
    makeInput([
      ticket({
        key: '01',
        slug: 'token-store',
        title: 'Add token store',
        status: 'ready-for-agent',
      }),
      ticket({
        key: '02',
        slug: 'refresh',
        title: 'Refresh on 401',
        status: 'done',
        blockedBy: ['01'],
      }),
    ]),
  )

  expect(item(result, '02')?.state).toBe('complete')
  expect(item(result, '02')?.evidence[0]?.strength).toBe('recorded')
})

test('needs-info blocks, wontfix is excluded from the total, and unknown statuses remain visible', () => {
  const result = readMatt(
    makeInput([
      ticket({ key: '01', slug: 'answer', title: 'Get an answer', status: 'needs-info' }),
      ticket({ key: '02', slug: 'drop', title: 'Drop this', status: 'wontfix' }),
      ticket({ key: '03', slug: 'odd', title: 'Odd status', status: 'bogus' }),
      ticket({ key: '04', slug: 'claimed', title: 'Claimed ticket', status: 'claimed' }),
      ticket({ key: '05', slug: 'agent', title: 'Agent ready', status: 'ready-for-agent' }),
      ticket({ key: '06', slug: 'human', title: 'Human ready', status: 'ready-for-human' }),
      ticket({ key: '07', slug: 'triage', title: 'Needs triage', status: 'needs-triage' }),
      ticket({ key: '08', slug: 'missing', title: 'Missing status' }),
    ]),
  )

  expect(item(result, '01')?.state).toBe('blocked')
  expect(item(result, '01')?.raw).toBe('needs-info')
  expect(item(result, '02')?.state).toBe('dropped')
  expect(result.total).toBe(7)
  expect(item(result, '03')?.state).toBe('unknown')
  expect(item(result, '03')?.raw).toBe('bogus')
  expect(item(result, '04')?.state).toBe('in-progress')
  expect(item(result, '05')?.state).toBe('open')
  expect(item(result, '06')?.state).toBe('open')
  expect(item(result, '07')?.state).toBe('open')
  expect(item(result, '08')?.state).toBe('unknown')
})

test('an observed implementation with commits completes its ticket weakly and leaves the next ticket in the frontier', () => {
  const first = ticket({
    key: '01',
    slug: 'token-store',
    title: 'Add token store',
    status: 'ready-for-agent',
  })
  const result = readMatt(
    makeInput(
      [
        first,
        ticket({
          key: '02',
          slug: 'refresh',
          title: 'Refresh on 401',
          status: 'ready-for-agent',
          blockedBy: ['01'],
        }),
        ticket({
          key: '03',
          slug: 'cache',
          title: 'Cache the result',
          status: 'ready-for-agent',
        }),
      ],
      {
        observed: [
          {
            skill: 'mattpocock-skills:implement',
            doc: first.path,
            branch: 'main',
            head: 'abc123',
            at: '2026-10-05T14:02:00Z',
            commitsSince: 2,
          },
          {
            skill: 'mattpocock-skills:implement',
            doc: '.scratch/demo/issues/03-cache.md',
            branch: 'main',
            head: 'abc123',
            at: '2026-10-05T14:03:00Z',
            commitsSince: 0,
          },
        ],
      },
    ),
  )

  expect(item(result, '01')?.state).toBe('complete')
  expect(item(result, '01')?.evidence[0]?.strength).toBe('observed')
  expect(item(result, '01')?.evidence[0]?.text).toContain('2 commits, ticket still open')
  expect(item(result, '03')?.state).toBe('in-progress')
  expect(item(result, '03')?.evidence[0]?.strength).toBe('observed')
  expect(result.frontier).toEqual(['02'])
  expect(result.weak).toBe(true)
  expect(result.phase).toBe('build')
})

test('related ticket evidence is retained and keeps that ticket out of the frontier', () => {
  const result = readMatt(
    makeInput(
      [
        ticket({
          key: '01',
          slug: 'token-store',
          title: 'Add token store',
          status: 'ready-for-agent',
        }),
      ],
      { relatedKeys: ['01'] },
    ),
  )

  expect(item(result, '01')?.evidence).toContainEqual({
    strength: 'related',
    source: 'commit',
    text: 'commit found, completion unknown',
  })
  expect(result.frontier).toEqual([])
  expect(result.phase).toBe('build')
  expect(result.weak).toBe(true)
})

test('all counted build tickets complete means the feature is done', () => {
  const result = readMatt(
    makeInput([
      ticket({ key: '01', slug: 'token-store', title: 'Add token store', status: 'closed' }),
    ]),
  )

  expect(result.phase).toBe('done')
  expect(result.weak).toBe(false)

  const observedResult = readMatt(
    makeInput(
      [
        ticket({
          key: '01',
          slug: 'token-store',
          title: 'Add token store',
          status: 'ready-for-agent',
        }),
      ],
      {
        observed: [
          {
            skill: 'mattpocock-skills:implement',
            doc: '.scratch/demo/issues/01-token-store.md',
            branch: 'main',
            head: 'abc123',
            at: '2026-10-05T14:02:00Z',
            commitsSince: 1,
          },
        ],
      },
    ),
  )

  expect(observedResult.phase).toBe('done')
  expect(observedResult.weak).toBe(true)
})

test('the open ticket frontier is sorted by ticket key', () => {
  const result = readMatt(
    makeInput([
      ticket({ key: '05', slug: 'last', title: 'Last ticket', status: 'ready-for-agent' }),
      ticket({ key: '03', slug: 'first', title: 'First ticket', status: 'ready-for-agent' }),
    ]),
  )

  expect(result.frontier).toEqual(['03', '05'])
})

test('an unmatched blocker marks its ticket unknown and explains the missing match', () => {
  const result = readMatt(
    makeInput([
      ticket({
        key: '04',
        slug: 'orphan',
        title: 'Orphan ticket',
        status: 'ready-for-agent',
        blockedBy: ['ghost'],
      }),
    ]),
  )

  expect(item(result, '04')?.state).toBe('unknown')
  expect(result.notes).toContain('ticket 04: blocker "ghost" matches no ticket')
})

test('every ticket participating in a blocker cycle becomes unknown with a note', () => {
  const result = readMatt(
    makeInput([
      ticket({
        key: '01',
        slug: 'first',
        title: 'First',
        status: 'ready-for-agent',
        blockedBy: ['02', '03'],
      }),
      ticket({
        key: '02',
        slug: 'second',
        title: 'Second',
        status: 'ready-for-agent',
        blockedBy: ['01'],
      }),
      ticket({
        key: '03',
        slug: 'third',
        title: 'Third',
        status: 'ready-for-agent',
        blockedBy: ['02'],
      }),
    ]),
  )

  expect(item(result, '01')?.state).toBe('unknown')
  expect(item(result, '02')?.state).toBe('unknown')
  expect(item(result, '03')?.state).toBe('unknown')
  expect(result.notes).toContain('ticket 01: blocker cycle')
  expect(result.notes).toContain('ticket 02: blocker cycle')
  expect(result.notes).toContain('ticket 03: blocker cycle')
})

test('a map with decisions stays in design and offers a statusless decision as its frontier', () => {
  const result = readMatt(
    makeInput(
      [
        ticket({
          key: '01',
          slug: 'storage',
          title: 'Choose storage',
          status: 'resolved',
          type: 'research',
        }),
        ticket({ key: '02', slug: 'queue', title: 'Choose queue', type: 'prototype' }),
        ticket({
          key: '03',
          slug: 'cache',
          title: 'Choose cache',
          status: 'claimed',
          type: 'task',
        }),
      ],
      { hasMap: true },
    ),
  )

  expect(result.phase).toBe('design')
  expect(result.decisions).toEqual([1, 3])
  expect(item(result, '02')?.state).toBe('open')
  expect(item(result, '02')?.type).toBe('prototype')
  expect(result.frontier).toEqual(['02'])
})

test('a decision with an unrecognized status stays unknown and out of the frontier', () => {
  const result = readMatt(
    makeInput(
      [
        ticket({
          key: '01',
          slug: 'storage',
          title: 'Choose storage',
          status: 'bogus',
          type: 'research',
        }),
      ],
      { hasMap: true },
    ),
  )

  expect(item(result, '01')?.state).toBe('unknown')
  expect(item(result, '01')?.raw).toBe('bogus')
  expect(result.frontier).toEqual([])
})

test('dropped decisions remain visible but are excluded from the decision count', () => {
  const result = readMatt(
    makeInput([
      ticket({
        key: '01',
        slug: 'storage',
        title: 'Choose storage',
        status: 'resolved',
        type: 'research',
      }),
      ticket({
        key: '02',
        slug: 'queue',
        title: 'Choose queue',
        status: 'wontfix',
        type: 'prototype',
      }),
    ]),
  )

  expect(result.decisions).toEqual([1, 1])
  expect(item(result, '02')?.state).toBe('dropped')
  expect(item(result, '02')?.raw).toBe('wontfix')
})

test('a spec and build tickets count separately from map decisions', () => {
  const result = readMatt(
    makeInput(
      [
        ticket({
          key: '01',
          slug: 'storage',
          title: 'Choose storage',
          status: 'resolved',
          type: 'research',
        }),
        ticket({ key: '02', slug: 'queue', title: 'Choose queue', type: 'prototype' }),
        ticket({
          key: '03',
          slug: 'cache',
          title: 'Choose cache',
          status: 'claimed',
          type: 'task',
        }),
        ticket({ key: '04', slug: 'store', title: 'Build store', status: 'ready-for-agent' }),
        ticket({ key: '05', slug: 'refresh', title: 'Build refresh', status: 'ready-for-agent' }),
      ],
      { hasMap: true, hasSpec: true },
    ),
  )

  expect(result.total).toBe(2)
  expect(result.decisions).toEqual([1, 3])
  expect(result.phase).toBe('plan')
})

test('an observed implement-spec start marks the reader weakly in build and explains pending ticket updates', () => {
  const result = readMatt(
    makeInput([], {
      hasSpec: true,
      observed: [
        {
          skill: 'mattpocock-skills:implement-spec',
          doc: '.scratch/demo/spec.md',
          branch: 'main',
          head: 'abc123',
          at: '2026-10-05T14:02:00Z',
          commitsSince: 0,
        },
      ],
    }),
  )

  expect(result.phase).toBe('build')
  expect(result.weak).toBe(true)
  expect(result.notes.some((note) => note.includes('ticket statuses update at its end'))).toBe(true)
})

test('unreadable tickets produce one unsupported-format note per path', () => {
  const result = readMatt(
    makeInput([], {
      unreadable: [
        { path: '.scratch/demo/issues/01-large.md', why: 'file over 1 MB' },
        { path: '.scratch/demo/issues/02-binary.md', why: 'not text' },
      ],
    }),
  )

  expect(result.notes).toContain(
    'ticket .scratch/demo/issues/01-large.md: unsupported format (file over 1 MB)',
  )
  expect(result.notes).toContain(
    'ticket .scratch/demo/issues/02-binary.md: unsupported format (not text)',
  )
})

test('branch-specific ticket differences remain attached to the item', () => {
  const result = readMatt(
    makeInput([
      ticket({
        key: '01',
        slug: 'token-store',
        title: 'Add token store',
        status: 'ready-for-agent',
        differsOn: ['integration/demo'],
      }),
    ]),
  )

  expect(item(result, '01')?.differsOn).toEqual(['integration/demo'])
})

test('hhmm formats an ISO timestamp in local time with zero-padded minutes', () => {
  expect(hhmm('2026-10-05T14:02:00')).toBe('14:02')
})
