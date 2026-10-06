import { expect, test } from 'claude-code/testing'
import { classifyDoc, docFromArgs, resolveFeature } from '../src/feature'
import type { DocRef, IdentityInput, NoteRef } from '../src/feature'

const SPEC = 'docs/superpowers/specs/2026-10-05-auth-design.md'
const PLAN = 'docs/superpowers/plans/2026-10-05-auth.md'

const plan = (path: string): DocRef => ({ kind: 'sp-plan', path })
const spec = (path: string): DocRef => ({ kind: 'sp-spec', path })

const note = (id: string, overrides: Partial<NoteRef> = {}): NoteRef => ({
  id,
  branches: [],
  unlinked: [],
  docs: { plan: `docs/superpowers/plans/${id}.md` },
  lastChange: 0,
  finished: false,
  ...overrides,
})

const input = (overrides: Partial<IdentityInput> = {}): IdentityInput => ({
  branch: 'feat/x',
  isDefault: false,
  notes: [],
  ledgerPlans: [],
  skillDocs: [],
  writtenDocs: [],
  commitDocs: [],
  planSpecs: {},
  docTimes: {},
  ...overrides,
})

test('classifyDoc makes ./ and absolute paths repo-relative and rejects other files', () => {
  const expected: DocRef = {
    kind: 'sp-plan',
    path: 'docs/superpowers/plans/2026-10-05-auth-refresh.md',
  }
  expect(classifyDoc('./docs/superpowers/plans/2026-10-05-auth-refresh.md', '/r')).toEqual(expected)
  expect(classifyDoc('/r/docs/superpowers/plans/2026-10-05-auth-refresh.md', '/r')).toEqual(
    expected,
  )
  expect(classifyDoc('src/x.ts', '/r')).toBe(null)
  for (const root of ['/wt/existing tree', 'C:/work/existing tree']) {
    expect(
      classifyDoc('../docs/superpowers/plans/2026-10-05-auth-refresh.md', root, `${root}/src`),
    ).toEqual(expected)
    expect(classifyDoc('../../elsewhere/docs/superpowers/plans/x.md', root, `${root}/src`)).toBe(
      null,
    )
  }
})

test('docFromArgs reads a quoted path only for library skills', () => {
  expect(
    docFromArgs('mattpocock-skills:implement', '".scratch/my feat/issues/02-t.md" now', '/r'),
  ).toEqual({
    kind: 'matt-ticket',
    path: '.scratch/my feat/issues/02-t.md',
    folder: '.scratch/my feat',
  })
  expect(
    docFromArgs('mattpocock-skills:implement', ".scratch/'my feat'/issues/02-t.md", '/r'),
  ).toEqual({
    kind: 'matt-ticket',
    path: '.scratch/my feat/issues/02-t.md',
    folder: '.scratch/my feat',
  })
  expect(
    docFromArgs(
      'superpowers:executing-plans',
      "--context='read docs/superpowers/specs/a.md first' docs/superpowers/plans/b.md",
      '/r',
    ),
  ).toEqual(plan('docs/superpowers/plans/b.md'))
  expect(
    docFromArgs(
      'superpowers:executing-plans',
      "--context='read docs/superpowers/specs/a.md first",
      '/r',
    ),
  ).toBe(null)
  expect(docFromArgs('commit', 'docs/superpowers/plans/x.md', '/r')).toBe(null)
  expect(
    docFromArgs(
      'superpowers:executing-plans',
      '"../docs/superpowers/plans/b.md"',
      '/wt/existing tree',
      '/wt/existing tree/src',
    ),
  ).toEqual(plan('docs/superpowers/plans/b.md'))
})

test('a ledger naming one note plan beats a linked note', () => {
  const result = resolveFeature(
    input({
      notes: [note('a'), note('b', { branches: ['feat/x'] })],
      ledgerPlans: [plan('docs/superpowers/plans/a.md')],
    }),
  )
  expect(result).toEqual({ kind: 'one', id: 'a', weak: false })
})

test('two active notes linked to the branch ask to choose', () => {
  const result = resolveFeature(
    input({
      notes: [
        note('a', { branches: ['feat/x'], lastChange: 1 }),
        note('b', { branches: ['feat/x'], lastChange: 2 }),
      ],
    }),
  )
  expect(result).toEqual({
    kind: 'choose',
    candidates: [
      { id: 'b', why: ['linked'], lastChange: 2, finished: false },
      { id: 'a', why: ['linked'], lastChange: 1, finished: false },
    ],
  })
})

test('a finished linked note gives way to a new spec written this session', () => {
  const result = resolveFeature(
    input({
      notes: [note('old', { branches: ['feat/x'], finished: true })],
      writtenDocs: [spec(SPEC)],
    }),
  )
  expect(result).toEqual({
    kind: 'one',
    id: 'auth',
    weak: false,
    create: spec(SPEC),
    switchedFrom: 'old',
  })
})

test('an active linked note and a newer written feature ask to choose, newest first', () => {
  const result = resolveFeature(
    input({
      notes: [note('a', { branches: ['feat/x'], lastChange: 5 })],
      writtenDocs: [spec(SPEC), plan(PLAN)],
      docTimes: { [SPEC]: 3, [PLAN]: 9 },
    }),
  )
  expect(result).toEqual({
    kind: 'choose',
    candidates: [
      { id: 'auth', why: ['written'], lastChange: 9, finished: false, create: spec(SPEC) },
      { id: 'a', why: ['linked'], lastChange: 5, finished: false },
    ],
  })
})

test('a written plan joins the note owning its spec', () => {
  const result = resolveFeature(
    input({
      notes: [note('m', { docs: { spec: '.scratch/m/spec.md' } })],
      writtenDocs: [plan(PLAN)],
      planSpecs: { [PLAN]: '.scratch/m/spec.md' },
    }),
  )
  expect(result).toEqual({ kind: 'one', id: 'm', weak: false })
})

test('a new plan and the new Matt spec it names are one feature, named by the spec', () => {
  const mattSpec = classifyDoc('.scratch/billing/spec.md', '/r')
  const rollout = plan('docs/superpowers/plans/billing-rollout.md')
  const result = (writtenDocs: DocRef[], more: Partial<IdentityInput> = {}) =>
    resolveFeature(
      input({ writtenDocs, planSpecs: { [rollout.path]: '.scratch/billing/spec.md' }, ...more }),
    )
  expect(mattSpec && result([mattSpec, rollout])).toEqual({
    kind: 'one',
    id: 'billing',
    weak: false,
    create: mattSpec,
  })
  // The plan reaches the refresh first: a ledger and skill start landed before its committed spec was read.
  expect(
    mattSpec &&
      result([], { ledgerPlans: [rollout], skillDocs: [rollout], commitDocs: [mattSpec, rollout] }),
  ).toEqual({ kind: 'one', id: 'billing', weak: false, create: rollout })
  // Both ids already exist when the plan that links them arrives.
  const rolloutSpec = spec('docs/superpowers/specs/billing-rollout-design.md')
  expect(mattSpec && result([mattSpec, rolloutSpec, rollout])).toEqual({
    kind: 'one',
    id: 'billing',
    weak: false,
    create: mattSpec,
  })
})

test('two ledgers naming plans of different notes ask to choose', () => {
  const result = resolveFeature(
    input({
      notes: [note('a'), note('b')],
      ledgerPlans: [plan('docs/superpowers/plans/a.md'), plan('docs/superpowers/plans/b.md')],
    }),
  )
  expect(result.kind).toBe('choose')
  expect(result.kind === 'choose' && result.candidates.map((c) => c.id).sort()).toEqual(['a', 'b'])
})

test('the default branch shows the newest note with no branch of its own, weakly', () => {
  const old = note('old', { branches: ['main'], lastChange: 1 })
  const result = (newer: NoteRef, writtenDocs: DocRef[] = []) =>
    resolveFeature(input({ branch: 'main', isDefault: true, notes: [old, newer], writtenDocs }))
  expect(result(note('new', { branches: ['main'], lastChange: 2 }))).toEqual({
    kind: 'one',
    id: 'new',
    weak: true,
  })
  expect(result(note('new', { branches: ['main', 'feat/new'], lastChange: 2 }))).toEqual({
    kind: 'one',
    id: 'old',
    weak: true,
  })
  const branched = note('new', { branches: ['main', 'feat/new'], lastChange: 2 })
  expect(result(branched, [plan('docs/superpowers/plans/new.md')])).toEqual({
    kind: 'one',
    id: 'old',
    weak: true,
  })
  const tied = resolveFeature(
    input({
      branch: 'main',
      isDefault: true,
      notes: [note('new', { branches: ['main'], lastChange: 1 }), old],
    }),
  )
  expect(tied.kind === 'choose' && tied.candidates.map((c) => c.id).sort()).toEqual(['new', 'old'])
})

test('a feature matched only by a document read after a skill started is weak', () => {
  const result = resolveFeature(
    input({ notes: [note('a')], readDoc: plan('docs/superpowers/plans/a.md') }),
  )
  expect(result).toEqual({ kind: 'one', id: 'a', weak: true })
})

test('a note unlinked from the branch drops out even when commits touch its docs', () => {
  const result = (unlinked: string[]) =>
    resolveFeature(
      input({
        notes: [note('a', { unlinked })],
        commitDocs: [plan('docs/superpowers/plans/a.md')],
      }),
    )
  expect(result([])).toEqual({ kind: 'one', id: 'a', weak: false })
  expect(result(['feat/x'])).toEqual({ kind: 'none' })
})

test('committed docs with no note start a feature', () => {
  const result = resolveFeature(input({ commitDocs: [spec(SPEC), plan(PLAN)] }))
  expect(result).toEqual({ kind: 'one', id: 'auth', weak: false, create: spec(SPEC) })
  const matt = classifyDoc('.scratch/ä/spec.md', '/r')
  expect(matt && resolveFeature(input({ commitDocs: [matt] }))).toEqual({
    kind: 'one',
    id: 'ä',
    weak: false,
    create: { kind: 'matt-spec', path: '.scratch/ä/spec.md', folder: '.scratch/ä' },
  })
})

test('no evidence resolves to none', () => {
  expect(resolveFeature(input())).toEqual({ kind: 'none' })
})
