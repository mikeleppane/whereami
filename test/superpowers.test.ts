import { expect, test } from 'claude-code/testing'
import { parseLedger, parsePlan, readSuperpowers, repoRelative } from '../src/superpowers'
import type { PlanInfo, SpInput, SpResult } from '../src/superpowers'
import type { ReadOutcome } from '../src/types'
import { REAL_LEDGER, THREE_TASK_PLAN } from './fixtures/sp'

const PLAN_PATH = 'docs/superpowers/plans/2026-10-05-auth.md'
const LEDGER_PATH = '.superpowers/sdd/2026-10-05-auth/progress.md'
const REPO_ROOT = '/repo'
const PLAN: PlanInfo = {
  tasks: [
    { n: 1, title: 'Add token store' },
    { n: 2, title: 'Refresh on 401' },
    { n: 3, title: 'Persist the session' },
  ],
  spec: 'docs/superpowers/specs/2026-10-05-auth-design.md',
}

const makeInput = (ledger: ReadOutcome | null, overrides: Partial<SpInput> = {}): SpInput => ({
  planPath: PLAN_PATH,
  plan: PLAN,
  ledger,
  ledgerPath: LEDGER_PATH,
  repoRoot: REPO_ROOT,
  previous: null,
  taskCommits: [],
  ...overrides,
})

const task = (result: SpResult, n: number) => result.items.find((item) => item.key === `Task ${n}`)
const successfulRead = (text: string): ReadOutcome => ({ ok: true, text })

test('parsePlan reads task headings and a backticked spec before trailing prose', () => {
  expect(parsePlan(THREE_TASK_PLAN)).toEqual({
    tasks: [
      { n: 1, title: 'Add token store' },
      { n: 2, title: 'Refresh on 401' },
      { n: 3, title: 'Persist the session' },
    ],
    spec: 'docs/superpowers/specs/2026-10-05-auth-design.md',
  })
})

test('parsePlan uses the first whitespace token when the spec path is not backticked', () => {
  expect(
    parsePlan('**Spec:** docs/superpowers/specs/plain.md supporting notes\n### Task 1: Build it'),
  ).toEqual({
    tasks: [{ n: 1, title: 'Build it' }],
    spec: 'docs/superpowers/specs/plain.md',
  })
})

test('parseLedger strips a BOM and CR characters while returning lines after the header', () => {
  expect(
    parseLedger(
      '\uFEFF# SDD ledger — plan: docs/superpowers/plans/auth.md\r\nTask 1: complete (commits a..b, review clean)\r\n',
    ),
  ).toEqual({
    plan: 'docs/superpowers/plans/auth.md',
    lines: ['Task 1: complete (commits a..b, review clean)', ''],
  })
})

test('repoRelative strips the repository prefix and a leading dot path only at path boundaries', () => {
  expect(repoRelative('/repo/docs/plan.md', '/repo')).toBe('docs/plan.md')
  expect(repoRelative('./docs/plan.md', '/repo')).toBe('docs/plan.md')
  expect(repoRelative('/repository/docs/plan.md', '/repo')).toBe('/repository/docs/plan.md')
})

test('a clean completion records the parenthetical evidence and leaves other tasks in build', () => {
  const result = readSuperpowers(
    makeInput(
      successfulRead(
        '# SDD ledger — plan: docs/superpowers/plans/2026-10-05-auth.md\nTask 1: complete (commits a..b, review clean)',
      ),
    ),
  )

  expect(result.phase).toBe('build')
  expect(task(result, 1)?.state).toBe('complete')
  expect(task(result, 1)?.reviewed).toBe(true)
  expect(task(result, 1)?.evidence).toEqual([
    {
      strength: 'recorded',
      source: `${LEDGER_PATH}:2`,
      text: 'commits a..b, review clean',
    },
  ])
})

test('a successfully read matching ledger marks its task items as current', () => {
  const result = readSuperpowers(
    makeInput(successfulRead('# SDD ledger — plan: docs/superpowers/plans/2026-10-05-auth.md')),
  )

  expect('currentLedger' in result ? result.currentLedger : undefined).toBe(true)
})

test('a completion with parked findings remains complete and records its parked count', () => {
  const result = readSuperpowers(
    makeInput(
      successfulRead(
        '# SDD ledger — plan: docs/superpowers/plans/2026-10-05-auth.md\nTask 2: complete (commits a..b, 2 parked)',
      ),
    ),
  )

  expect(task(result, 2)?.state).toBe('complete')
  expect(task(result, 2)?.parked).toBe(2)
  expect(task(result, 2)?.reviewed).toBe(undefined)
})

test('a finding after completion is retained without replacing the task status', () => {
  const result = readSuperpowers(
    makeInput(
      successfulRead(
        '# SDD ledger — plan: docs/superpowers/plans/2026-10-05-auth.md\nTask 2: complete (commits a..b, review clean)\nTask 2: parked — x — Ruling: y',
      ),
    ),
  )

  expect(task(result, 2)?.state).toBe('complete')
  expect(task(result, 2)?.findings).toEqual(['Task 2: parked — x — Ruling: y'])
})

test('a fix round is in progress and retains its current and maximum round', () => {
  const result = readSuperpowers(
    makeInput(
      successfulRead(
        '# SDD ledger — plan: docs/superpowers/plans/2026-10-05-auth.md\nTask 3: fix round 2/5 (review findings)',
      ),
    ),
  )

  expect(task(result, 3)?.state).toBe('in-progress')
  expect(task(result, 3)?.fixRound).toEqual([2, 5])
})

test('executing-plans test output is preserved as task evidence', () => {
  const result = readSuperpowers(
    makeInput(
      successfulRead(
        '# SDD ledger — plan: docs/superpowers/plans/2026-10-05-auth.md\nTask 1: complete (tests: npm test → 8/8 pass)',
      ),
    ),
  )

  expect(task(result, 1)?.evidence[0]?.text).toBe('tests: npm test → 8/8 pass')
})

test('all plan tasks complete with a ledger means review, not done', () => {
  const result = readSuperpowers(
    makeInput(
      successfulRead(
        [
          '# SDD ledger — plan: docs/superpowers/plans/2026-10-05-auth.md',
          'Task 1: complete (commits a..b, review clean)',
          'Task 2: complete (commits b..c, review clean)',
          'Task 3: complete (commits c..d, review clean)',
        ].join('\n'),
      ),
    ),
  )

  expect(result.phase).toBe('review')
  expect(result.allComplete).toBe(true)
  expect(result.ledgerSeen).toBe(true)
})

test('a removed ledger after a complete snapshot restores every task including parked findings', () => {
  const result = readSuperpowers(
    makeInput(null, {
      previous: {
        phase: 'review',
        tasks: {
          '1': { state: 'complete', evidence: 'commits a..b, review clean', reviewed: true },
          '2': { state: 'complete', evidence: 'commits b..c, review clean', reviewed: true },
          '3': { state: 'complete', evidence: 'commits c..d, 1 parked', parked: 1 },
        },
        allComplete: true,
        ledgerSeen: true,
        source: LEDGER_PATH,
        seen: '2026-10-05T14:32:00Z',
      },
    }),
  )

  expect(result.phase).toBe('done')
  expect(result.items).toHaveLength(3)
  expect(task(result, 3)?.state).toBe('complete')
  expect(task(result, 3)?.parked).toBe(1)
  expect(task(result, 3)?.evidence[0]?.text.includes('before it was removed')).toBe(true)
})

test('a removed ledger before completion stays unknown and restores the snapshot tasks', () => {
  const result = readSuperpowers(
    makeInput(null, {
      previous: {
        phase: 'build',
        tasks: {
          '1': { state: 'complete', evidence: 'commits a..b, review clean', reviewed: true },
          '2': { state: 'in-progress', evidence: 'fix round 2/5', fixRound: [2, 5] },
        },
        allComplete: false,
        ledgerSeen: true,
        source: LEDGER_PATH,
        seen: '2026-10-05T14:32:00Z',
      },
    }),
  )

  expect(result.phase).toBe('unknown')
  expect(result.notes).toContain('progress file removed before the build was seen to finish')
  expect(result.items.map((item) => item.key)).toEqual(['Task 1', 'Task 2'])
})

test('related task commits without a ledger stay unknown and weak', () => {
  const result = readSuperpowers(makeInput(null, { taskCommits: [1, 2] }))

  expect(result.phase).toBe('build')
  expect(result.weak).toBe(true)
  expect(
    result.items.map((item) => [
      item.key,
      item.state,
      item.evidence[0]?.strength,
      item.evidence[0]?.text,
    ]),
  ).toEqual([
    ['Task 1', 'unknown', 'related', 'commit found, completion unknown'],
    ['Task 2', 'unknown', 'related', 'commit found, completion unknown'],
  ])
})

test('ledger headers using relative dot paths and absolute paths match the plan', () => {
  for (const header of [
    '# SDD ledger — plan: ./docs/superpowers/plans/2026-10-05-auth.md',
    '# SDD ledger — plan: /repo/docs/superpowers/plans/2026-10-05-auth.md',
  ]) {
    const result = readSuperpowers(makeInput(successfulRead(header)))
    expect(result.phase).toBe('build')
    expect(result.unsupported).toBe(undefined)
  }
})

test('wrong headers, empty files, and unreadable ledger outcomes are unsupported', () => {
  const inputs: ReadOutcome[] = [
    successfulRead('not a Superpowers ledger'),
    successfulRead(''),
    { ok: false, why: 'too-big' },
    { ok: false, why: 'not-text' },
    { ok: false, why: 'missing' },
    { ok: false, why: 'error' },
  ]

  for (const ledger of inputs) {
    const result = readSuperpowers(makeInput(ledger))
    expect(result.unsupported).toBe(
      ledger.ok ? 'not a Superpowers ledger' : 'file over 1 MB or not text',
    )
  }
})

test('a ledger naming another plan is unsupported', () => {
  const result = readSuperpowers(
    makeInput(
      successfulRead(
        '# SDD ledger — plan: docs/superpowers/plans/another.md\nTask 1: complete (commits a..b, review clean)',
      ),
    ),
  )

  expect(result.unsupported).toBe('ledger names another plan')

  const missingPlan = readSuperpowers(
    makeInput(successfulRead('# SDD ledger — plan: docs/superpowers/plans/another.md'), {
      plan: null,
    }),
  )
  expect(missingPlan.unsupported).toBe('ledger names another plan')

  const matchingMissingPlan = readSuperpowers(
    makeInput(successfulRead('# SDD ledger — plan: docs/superpowers/plans/2026-10-05-auth.md'), {
      plan: null,
    }),
  )
  expect(matchingMissingPlan.phase).toBe('design')
  expect(matchingMissingPlan.unsupported).toBe(undefined)
})

test('out-of-order CRLF lines and a truncated final status retain established progress', () => {
  const clean = readSuperpowers(
    makeInput(
      successfulRead(
        [
          '# SDD ledger — plan: docs/superpowers/plans/2026-10-05-auth.md',
          'Task 1: complete (commits a..b, review clean)',
          'Task 2: fix round 2/5 (review findings)',
        ].join('\n'),
      ),
    ),
  )
  const varied = readSuperpowers(
    makeInput(
      successfulRead(
        '\uFEFF# SDD ledger — plan: docs/superpowers/plans/2026-10-05-auth.md\r\nTask 2: fix round 2/5 (review findings)\r\nTask 1: complete (commits a..b, review clean)\r\nTask 1: complete (commits c..',
      ),
    ),
  )
  const summary = (result: SpResult) =>
    result.items.map((item) => [
      item.key,
      item.title,
      item.state,
      item.reviewed ?? null,
      item.fixRound ?? null,
    ])
  const expected = [
    ['Task 1', 'Add token store', 'complete', true, null],
    ['Task 2', 'Refresh on 401', 'in-progress', null, [2, 5]],
    ['Task 3', 'Persist the session', 'open', null, null],
  ]

  expect(summary(clean)).toEqual(expected)
  expect(summary(varied)).toEqual(expected)
  expect(varied.phase).toBe('build')
  expect(task(varied, 1)?.evidence).toEqual([
    {
      strength: 'recorded',
      source: `${LEDGER_PATH}:3`,
      text: 'commits a..b, review clean',
    },
  ])
  expect(task(varied, 1)?.findings).toEqual(['Task 1: complete (commits c..'])
})

test('real free-form ledger lines stay notes or task findings, including final review', () => {
  const result = readSuperpowers(
    makeInput(successfulRead(`${REAL_LEDGER}\nFinal: final review remains pending`), {
      planPath: 'docs/superpowers/plans/2026-10-05-slugify.md',
      ledgerPath: 'docs/superpowers/plans/progress.md',
      plan: {
        tasks: [
          { n: 1, title: 'Slugify values' },
          { n: 2, title: 'Handle empty values' },
        ],
      },
    }),
  )

  expect(result.notes).toEqual([
    'Spec read: …',
    'Preflight scan:',
    '| Check | Result |',
    '| --- | --- |',
    '| Task plan | valid |',
    'Ruling: Task 2 covers the gap — cost: none.',
    'final review: final review remains pending',
  ])
  expect(task(result, 1)?.state).toBe('complete')
  expect(task(result, 1)?.findings).toEqual(['Task 1: minor (deferred): …'])
})

test('later completion status wins while both status lines remain evidence', () => {
  const result = readSuperpowers(
    makeInput(
      successfulRead(
        [
          '# SDD ledger — plan: docs/superpowers/plans/2026-10-05-auth.md',
          'Task 1: complete (commits a..b, 2 parked)',
          'Task 1: complete (commits c..d, 1 parked)',
        ].join('\n'),
      ),
    ),
  )

  expect(task(result, 1)?.state).toBe('complete')
  expect(task(result, 1)?.parked).toBe(1)
  expect(task(result, 1)?.evidence).toEqual([
    {
      strength: 'recorded',
      source: `${LEDGER_PATH}:2`,
      text: 'commits a..b, 2 parked',
    },
    {
      strength: 'recorded',
      source: `${LEDGER_PATH}:3`,
      text: 'commits c..d, 1 parked',
    },
  ])
})

test('a ledger task absent from the plan is reported without creating an item', () => {
  const result = readSuperpowers(
    makeInput(
      successfulRead(
        '# SDD ledger — plan: docs/superpowers/plans/2026-10-05-auth.md\nTask 9: complete (commits a..b, review clean)',
      ),
    ),
  )

  expect(result.notes).toContain('plan and progress disagree: Task 9')
  expect(result.items).toHaveLength(3)
})

test('a plan with no task headings is unknown with an explanatory note', () => {
  const result = readSuperpowers(makeInput(null, { plan: { tasks: [] } }))

  expect(result.phase).toBe('unknown')
  expect(result.notes).toContain('plan has no tasks')
})

test('a missing plan leaves the feature in design', () => {
  const result = readSuperpowers(makeInput(null, { plan: null }))

  expect(result.phase).toBe('design')
})

test('a plan without prior ledger or related commits stays in plan', () => {
  expect(readSuperpowers(makeInput(null)).phase).toBe('plan')
})
