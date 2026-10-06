import { expect, test } from 'claude-code/testing'
import type { RememberInput } from '../src/remember'
import { remember } from '../src/remember'
import type { SpResult } from '../src/superpowers'
import { readSuperpowers } from '../src/superpowers'
import type { Note, Observed } from '../src/types'

const NOW = new Date('2026-10-06T12:34:56.000Z')
const SEEN = '2026-10-06T12:34:56.000Z'
const LEDGER = '.superpowers/sdd/auth/progress.md'

const headline = (phase: RememberInput['headline']['phase']): RememberInput['headline'] => ({
  phase,
  weak: false,
  blocked: 0,
})

const input = (overrides: Partial<RememberInput> = {}): RememberInput => ({
  prev: null,
  prevInvalid: false,
  id: 'auth-refresh',
  branch: 'feat/auth-refresh',
  head: 'abc123',
  isDefault: false,
  hasOwnCommits: false,
  docs: { plan: 'docs/superpowers/plans/auth.md' },
  planHeadings: null,
  sp: null,
  headline: headline('plan'),
  sessionObserved: [],
  now: NOW,
  ...overrides,
})

const result = (overrides: Partial<SpResult> = {}): SpResult => ({
  library: 'superpowers',
  docs: { plan: 'docs/superpowers/plans/auth.md' },
  items: [
    {
      key: 'Task 1',
      title: 'Add token store',
      kind: 'task',
      state: 'complete',
      reviewed: true,
      evidence: [
        { strength: 'recorded', source: `${LEDGER}:2`, text: 'task one evidence' },
        { strength: 'recorded', source: `${LEDGER}:3`, text: 'later evidence' },
      ],
    },
    {
      key: 'Task 2',
      title: 'Refresh on 401',
      kind: 'task',
      state: 'in-progress',
      fixRound: [2, 5],
      evidence: [{ strength: 'recorded', source: `${LEDGER}:4`, text: 'task two evidence' }],
    },
    {
      key: 'Task 3',
      title: 'Persist session',
      kind: 'task',
      state: 'complete',
      parked: 1,
      evidence: [{ strength: 'recorded', source: `${LEDGER}:5`, text: 'task three evidence' }],
    },
  ],
  total: 3,
  phase: 'build',
  weak: false,
  notes: [],
  allComplete: false,
  ledgerSeen: true,
  currentLedger: true,
  ...overrides,
})

const previousNote = (overrides: Partial<Note> = {}): Note => ({
  version: 1,
  id: 'auth-refresh',
  branches: ['feat/auth-refresh'],
  unlinked: [],
  tips: {},
  docs: {},
  planTasks: [],
  observed: [],
  last: null,
  ...overrides,
})

test('a fresh note records its feature and branch without a tip when it has no own commits', () => {
  const remembered = remember(input(), null)

  expect(remembered.note).toEqual({
    version: 1,
    id: 'auth-refresh',
    branches: ['feat/auth-refresh'],
    unlinked: [],
    tips: {},
    docs: { plan: 'docs/superpowers/plans/auth.md' },
    planTasks: [],
    observed: [],
    last: null,
  })
  expect(remembered.finishedAt).toBe(null)
  expect(remembered.notices).toEqual([])
})

test('observations merge once by skill, document and time', () => {
  const old: Observed = {
    skill: 'mattpocock-skills:implement',
    doc: '.scratch/auth/issues/01.md',
    branch: 'feat/auth-refresh',
    head: 'abc123',
    at: '2026-10-06T10:00:00Z',
  }
  const duplicate: Observed = { ...old, branch: 'main', head: 'different' }
  const added: Observed = {
    skill: 'superpowers:subagent-driven-development',
    doc: 'docs/superpowers/plans/auth.md',
    branch: 'feat/auth-refresh',
    head: 'def456',
    at: '2026-10-06T11:00:00Z',
  }

  const remembered = remember(
    input({
      prev: previousNote({ observed: [old, duplicate] }),
      sessionObserved: [added, old],
    }),
    null,
  )

  expect(remembered.note.observed).toEqual([old, added])
})

test('missing plans and unreadable ledgers preserve the saved task snapshot', () => {
  const previous = remember(input({ sp: result(), headline: headline('build') }), null).note
  expect(Object.keys(previous.last?.tasks ?? {})).toHaveLength(3)

  const cases = [
    { plan: null, ledger: null },
    { plan: { tasks: [] }, ledger: null },
    {
      plan: {
        tasks: [
          { n: 1, title: 'Add token store' },
          { n: 2, title: 'Refresh on 401' },
          { n: 3, title: 'Persist session' },
        ],
      },
      ledger: { ok: false as const, why: 'error' as const },
    },
  ]

  for (const { plan, ledger } of cases) {
    const sp = readSuperpowers({
      planPath: 'docs/superpowers/plans/auth.md',
      plan,
      ledger,
      ledgerPath: LEDGER,
      repoRoot: '/repo',
      previous: previous.last,
      taskCommits: [],
    })
    const remembered = remember(input({ prev: previous, sp, headline: headline('unknown') }), null)

    expect(remembered.note.last).toEqual({ ...previous.last, phase: 'unknown' })
  }
})

test('a current ledger overwrites the prior snapshot', () => {
  const previous = remember(input({ sp: result(), headline: headline('build') }), null).note
  const sp = readSuperpowers({
    planPath: 'docs/superpowers/plans/auth.md',
    plan: {
      tasks: [
        { n: 1, title: 'Add token store' },
        { n: 2, title: 'Refresh on 401' },
        { n: 3, title: 'Persist session' },
      ],
    },
    ledger: {
      ok: true,
      text: [
        '# SDD ledger — plan: docs/superpowers/plans/auth.md',
        'progress file removed before the build was seen to finish',
        'Task 1: fix round 1/3 (from the progress file before it was removed)',
        'Task 2: fix round 1/5 (spec reviewer: missing test)',
        'Task 2: complete (commits c..d, 1 parked)',
      ].join('\n'),
    },
    ledgerPath: LEDGER,
    repoRoot: '/repo',
    previous: previous.last,
    taskCommits: [],
  })
  const remembered = remember(
    input({ prev: previous, sp, source: LEDGER, headline: headline('build') }),
    null,
  )

  expect(remembered.note.last?.tasks['1']).toEqual({
    state: 'in-progress',
    fixRound: [1, 3],
    evidence: 'from the progress file before it was removed',
  })
  // The evidence kept is the winning status line's, not the earlier fix round's.
  expect(remembered.note.last?.tasks['2']).toEqual({
    state: 'complete',
    parked: 1,
    evidence: 'commits c..d, 1 parked',
  })
})

test('a ledger snapshot keeps three task statuses after the ledger is gone', () => {
  const first = remember(
    input({
      sp: result(),
      source: `/repo/${LEDGER}`,
      planHeadings: [
        'Task 1: Add token store',
        'Task 2: Refresh on 401',
        'Task 3: Persist session',
      ],
      headline: headline('build'),
    }),
    null,
  )

  expect(first.note.last).toEqual({
    phase: 'build',
    tasks: {
      '1': { state: 'complete', reviewed: true, evidence: 'later evidence' },
      '2': { state: 'in-progress', fixRound: [2, 5], evidence: 'task two evidence' },
      '3': { state: 'complete', parked: 1, evidence: 'task three evidence' },
    },
    allComplete: false,
    ledgerSeen: true,
    plan: 'docs/superpowers/plans/auth.md',
    source: `/repo/${LEDGER}`,
    seen: SEEN,
  })

  const removedLedger = readSuperpowers({
    planPath: 'docs/superpowers/plans/auth.md',
    plan: {
      tasks: [
        { n: 1, title: 'Add token store' },
        { n: 2, title: 'Refresh on 401' },
        { n: 3, title: 'Persist session' },
      ],
    },
    ledger: null,
    ledgerPath: LEDGER,
    repoRoot: '/repo',
    previous: first.note.last,
    taskCommits: [],
  })
  const later = remember(
    input({
      prev: first.note,
      sp: removedLedger,
      headline: headline('unknown'),
    }),
    null,
  )

  expect(later.note.last).toEqual({ ...first.note.last, phase: 'unknown' })
})

test('linking a branch clears unlinking, records its tip, and preserves the previous note', () => {
  const previous = previousNote({ branches: [], unlinked: ['feat/auth-refresh'] })
  const remembered = remember(
    input({
      prev: previous,
      hasOwnCommits: true,
    }),
    null,
  )

  expect(remembered.note.branches).toEqual(['feat/auth-refresh'])
  expect(remembered.note.unlinked).toEqual([])
  expect(remembered.note.tips).toEqual({ 'feat/auth-refresh': 'abc123' })
  expect(previous.branches).toEqual([])
  expect(previous.unlinked).toEqual(['feat/auth-refresh'])
})

test('new document paths replace matching values and preserve other documents', () => {
  const remembered = remember(
    input({
      prev: previousNote({ docs: { spec: 'docs/old.md', plan: 'docs/old-plan.md' } }),
      docs: { plan: 'docs/new-plan.md' },
    }),
    null,
  )

  expect(remembered.note.docs).toEqual({ spec: 'docs/old.md', plan: 'docs/new-plan.md' })
})

test('plan headings freeze at the first ledger and later edits raise a notice', () => {
  const first = remember(
    input({
      sp: result(),
      source: LEDGER,
      planHeadings: ['Task 1: Add token store', 'Task 2: Refresh on 401'],
      headline: headline('build'),
    }),
    null,
  )
  const changed = remember(
    input({
      prev: first.note,
      sp: result(),
      source: LEDGER,
      planHeadings: ['Task 1: Add token store', 'Task 2: Retry refresh', 'Task 3: Persist session'],
      headline: headline('build'),
    }),
    null,
  )

  expect(changed.note.planTasks).toEqual(['Task 1: Add token store', 'Task 2: Refresh on 401'])
  expect(changed.notices).toContain('plan edited since the build started')

  const initialHeadings = ['Task 1: Add token store', 'Task 2: Refresh on 401']
  const unreadable = readSuperpowers({
    planPath: 'docs/superpowers/plans/auth.md',
    plan: {
      tasks: [
        { n: 1, title: 'Add token store' },
        { n: 2, title: 'Refresh on 401' },
      ],
    },
    ledger: { ok: false, why: 'error' },
    ledgerPath: LEDGER,
    repoRoot: '/repo',
    previous: null,
    taskCommits: [],
  })
  const firstUnreadable = remember(
    input({
      sp: unreadable,
      planHeadings: initialHeadings,
      headline: headline('unknown'),
    }),
    null,
  )

  expect(firstUnreadable.note.last).toBe(null)

  const changedHeadings = [
    'Task 1: Add token store',
    'Task 2: Retry refresh',
    'Task 3: Persist session',
  ]
  const removedAfterUnreadable = readSuperpowers({
    planPath: 'docs/superpowers/plans/auth.md',
    plan: {
      tasks: [
        { n: 1, title: 'Add token store' },
        { n: 2, title: 'Retry refresh' },
        { n: 3, title: 'Persist session' },
      ],
    },
    ledger: null,
    ledgerPath: LEDGER,
    repoRoot: '/repo',
    previous: firstUnreadable.note.last,
    taskCommits: [],
  })
  const editedAfterRemoval = remember(
    input({
      prev: firstUnreadable.note,
      sp: removedAfterUnreadable,
      planHeadings: changedHeadings,
      headline: headline('plan'),
    }),
    null,
  )

  expect(editedAfterRemoval.note.planTasks).toEqual(initialHeadings)
  expect(editedAfterRemoval.notices).toContain('plan edited since the build started')
  expect(editedAfterRemoval.note.last).toBe(null)

  const validLedger = readSuperpowers({
    planPath: 'docs/superpowers/plans/auth.md',
    plan: {
      tasks: [
        { n: 1, title: 'Add token store' },
        { n: 2, title: 'Retry refresh' },
        { n: 3, title: 'Persist session' },
      ],
    },
    ledger: { ok: true, text: '# SDD ledger — plan: docs/superpowers/plans/auth.md' },
    ledgerPath: LEDGER,
    repoRoot: '/repo',
    previous: firstUnreadable.note.last,
    taskCommits: [],
  })
  const editedAfterUnreadable = remember(
    input({
      prev: firstUnreadable.note,
      sp: validLedger,
      planHeadings: changedHeadings,
      headline: headline('build'),
    }),
    null,
  )

  expect(editedAfterUnreadable.note.planTasks).toEqual(initialHeadings)
  expect(editedAfterUnreadable.notices).toContain('plan edited since the build started')
})

test('done records the finish time once until a replacement plan starts', () => {
  const finished = remember(
    input({
      headline: headline('done'),
    }),
    null,
  )
  const later = remember(
    input({
      prev: finished.note,
      headline: headline('merged'),
      now: new Date('2026-10-07T12:34:56.000Z'),
    }),
    finished.finishedAt,
  )

  expect(finished.finishedAt).toBe(Math.floor(NOW.getTime() / 1000))
  expect(later.finishedAt).toBe(finished.finishedAt)

  const replacement = remember(
    input({
      prev: later.note,
      docs: { plan: 'docs/superpowers/plans/replacement.md' },
      headline: headline('plan'),
    }),
    later.finishedAt,
  )
  expect(replacement.note.docs.plan).toBe('docs/superpowers/plans/replacement.md')
  expect(replacement.finishedAt).toBe(null)
})

// Spec section 3: `finished` holds when the feature reached done or merged, "empty otherwise". Unknown is no
// evidence either way: it neither starts nor clears the expiry clock.
test('a finished feature reopened on the same plan clears its finish time; unknown keeps it', () => {
  // Done at NOW (2026-10-06T12:34:56Z), unknown a day later, reopened a day after that.
  const done = remember(input({ headline: headline('done') }), null)
  const unknown = remember(
    input({
      prev: done.note,
      headline: headline('unknown'),
      now: new Date('2026-10-07T12:34:56.000Z'),
    }),
    done.finishedAt,
  )
  const reopened = remember(
    input({
      prev: unknown.note,
      headline: headline('build'),
      now: new Date('2026-10-08T12:34:56.000Z'),
    }),
    unknown.finishedAt,
  )

  expect(done.finishedAt).toBe(1791290096)
  expect(done.note.docs.plan).toBe('docs/superpowers/plans/auth.md')
  expect(unknown.finishedAt).toBe(1791290096)
  expect(reopened.note.docs.plan).toBe('docs/superpowers/plans/auth.md')
  expect(reopened.finishedAt).toBe(null)
  const fresh = input({ headline: headline('unknown'), now: new Date('2026-10-07T12:34:56.000Z') })
  expect(remember(fresh, null).finishedAt).toBe(null)
})

test('an invalid previous note adds the unreadable-record notice', () => {
  const remembered = remember(input({ prevInvalid: true }), null)

  expect(remembered.notices).toEqual([
    "whereami's earlier record was unreadable; rebuilt from files and git",
  ])
})

test('the default branch is not added when the feature already has another branch', () => {
  const remembered = remember(
    input({
      prev: previousNote({ branches: ['feat/auth-refresh'] }),
      branch: 'main',
      isDefault: true,
    }),
    null,
  )

  expect(remembered.note.branches).toEqual(['feat/auth-refresh'])
})

test('a detached update never records a null branch or tip', () => {
  const remembered = remember(
    input({
      branch: null,
      hasOwnCommits: true,
    }),
    null,
  )

  expect(remembered.note.id).toBe('auth-refresh')
  expect(remembered.note.branches).toEqual([])
  expect(remembered.note.tips).toEqual({})
})
