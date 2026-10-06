import { expect, test } from 'claude-code/testing'
import { readNotes } from '../src/gather'
import { serializeNote } from '../src/notes'
import { refresh, type SessionFacts } from '../src/refresh'
import type { View } from '../src/text'
import type { GitResult, Note } from '../src/types'
import { fakeIo } from './fake-io'
import {
  complete,
  git,
  HEAD,
  LEDGER,
  ledger,
  PLAN,
  type Repo,
  repo,
  spWorld,
} from './fixtures/repo'
import { THREE_TASK_PLAN } from './fixtures/sp'

const TIP = 'd'.repeat(40)
const START = 'e'.repeat(40)
const W = '/r/.git/whereami'
const SPEC = 'docs/superpowers/specs/2026-10-05-auth-design.md'

// git(r), except the calls `differ` answers; undefined leaves a call to git(r).
const gitBut =
  (r: Repo, differ: (a: string) => GitResult | string | null | undefined) =>
  (args: string[], stdin?: string) => {
    const answer = differ(args.join(' '))
    return answer === undefined ? git(r)(args, stdin) : answer
  }

const session = (fields: Partial<SessionFacts> = {}): SessionFacts => ({
  observed: [],
  skillDocs: [],
  writtenDocs: [],
  agentsRunning: 0,
  agentsBeforeClear: 0,
  installed: new Set(['superpowers:finishing-a-development-branch']),
  // Nothing on disk counts as written this session unless a test says when it started.
  since: Number.POSITIVE_INFINITY,
  ...fields,
})

const note = (fields: Partial<Note>): Note => ({
  version: 1,
  id: 'auth',
  branches: [],
  unlinked: [],
  tips: {},
  docs: {},
  planTasks: [],
  observed: [],
  last: null,
  ...fields,
})

const feature = (view: View | null) => {
  if (view?.kind !== 'feature') throw new Error(`not a feature view: ${view?.kind}`)
  return view
}

test('a Superpowers build mid-way writes its note and the branch summary', async () => {
  const io = fakeIo(spWorld(complete(1)), git(repo()))
  const v = feature((await refresh(io, session())).view)
  expect(v.headline.phase).toBe('build')
  expect(v.headline.count).toEqual([1, 3])
  expect(Object.keys(io.written)).toContain(`${W}/features/auth/note.json`)
  expect(io.written[`${W}/branches/feat%2Fauth/message`]).toMatch(/\n\.\n$/)
})

for (const marker of ['legacy', 'corrupt', 'wrong-version', 'wrong-id', 'empty', 'denied'] as const)
  test(`a ${marker} forget marker blocks unowned discovery until cleanup but not owned work`, async () => {
    const path = `${W}/features/auth/forget`
    const contents = {
      legacy: 'forget\n',
      corrupt: '{"version":',
      'wrong-version': '{"version":2,"id":"auth","documents":[".scratch/auth/"]}\n',
      'wrong-id': '{"version":1,"id":"other","documents":[".scratch/auth/"]}\n',
      empty: '{"version":1,"id":"auth","documents":[]}\n',
      denied: '{"version":1,"id":"auth","documents":[".scratch/auth/"]}\n',
    }
    const files: Record<string, string> = {
      ...spWorld(complete(1)),
      [path]: contents[marker],
      [`${W}/features/owned/note.json`]: serializeNote(
        note({
          id: 'owned',
          branches: ['feat/auth'],
          docs: { spec: 'docs/superpowers/specs/owned-design.md' },
        }),
      ),
    }
    const io = fakeIo(files, git(repo()))
    const read = io.read
    io.read = (p) =>
      p === path && marker === 'denied' ? Promise.resolve({ ok: false, why: 'error' }) : read(p)
    expect(feature((await refresh(io, session())).view).featureId).toBe('owned')
    expect(Object.keys(io.written).filter((p) => p.endsWith('/note.json'))).toEqual([
      `${W}/features/owned/note.json`,
    ])
    delete files[path]
    expect(feature((await refresh(io, session())).view).featureId).toBe('auth')
    expect(io.written[`${W}/features/auth/note.json`]).toBeDefined()
  })

test('forget snapshots all known documents and excludes later plan and Matt group links', async () => {
  const otherPlan = 'docs/superpowers/plans/2026-10-06-rollout.md'
  const map = '.scratch/auth/map.md'
  const files: Record<string, string> = {
    ...spWorld(complete(1)),
    [`/r/${otherPlan}`]: `**Spec:** \`${SPEC}\`\n### Task 1: Roll out\n`,
    [`/r/${map}`]: '# Auth map\n',
    [`${W}/features/auth/note.json`]: serializeNote(
      note({
        branches: ['feat/auth'],
        docs: { plan: PLAN, spec: SPEC, map, tickets: '.scratch/auth/issues/' },
      }),
    ),
  }
  const io = fakeIo(files, git(repo()))
  const before = await refresh(io, session({ writtenDocs: [otherPlan] }))
  expect(feature(before.view).featureId).toBe('auth')
  expect({ ...before.forget, documents: before.forget?.documents.slice().sort() }).toEqual({
    id: 'auth',
    documents: ['.scratch/auth/', '.scratch/auth/issues/', map, PLAN, otherPlan, SPEC],
  })
  files[`${W}/features/auth/forget`] = `${JSON.stringify({ version: 1, ...before.forget })}\n`
  delete files[`${W}/features/auth/note.json`]
  // Old links disappear: only the snapshot can still connect the rollout plan to auth.
  delete files[`/r/${PLAN}`]
  delete files[`/r/${otherPlan}`]
  const newSpec = 'docs/superpowers/specs/2026-10-06-replacement-design.md'
  files[`/r/${otherPlan}`] = `**Spec:** \`${newSpec}\`\n`
  const newPlan = 'docs/superpowers/plans/2026-10-06-followup.md'
  files[`/r/${newPlan}`] = `**Spec:** \`.scratch/auth/spec.md\`\n`
  const unrelated = 'docs/superpowers/specs/2026-10-07-auth-design.md'
  const next = session({
    skillDocs: [newPlan],
    writtenDocs: [newSpec, '.scratch/auth/spec.md', '.scratch/auth/issues/02-new.md'],
  })
  expect((await refresh(io, next)).view).toBe(null)
  // Another document with the same base id is not forgotten and must not overwrite the tombstone.
  const after = feature((await refresh(io, { ...next, writtenDocs: [unrelated] })).view)
  expect(after.featureId).toBe('auth-2')
  expect(after.docs).toEqual({ spec: unrelated })
  expect(io.written[`${W}/features/auth-2/note.json`]).toBeDefined()
})

test('lifecycle: review, done from the snapshot, merged, then unknown after a squash merge', async () => {
  const files = spWorld(complete(1), complete(2), complete(3))
  const r = repo({ log: `\0${TIP}\tplan\0\n${PLAN}\0` })
  const io = fakeIo(files, git(r))
  expect(feature((await refresh(io, session())).view).headline.phase).toBe('review')

  delete files[LEDGER]
  const done = feature((await refresh(io, session())).view)
  expect(done.headline.phase).toBe('done')
  expect(done.sp?.items.map((i) => i.state)).toEqual(['complete', 'complete', 'complete'])
  expect(done.next?.command).toContain('finishing-a-development-branch')
  // The branch is still there, so a tip that is no ancestor proves "not merged".
  expect(done.merged).toBe(false)

  r.merged = true
  expect(feature((await refresh(io, session())).view).headline.phase).toBe('merged')

  // Squash-merged and deleted: the stored tip is no ancestor and the branch is gone; HEAD sits on the old tip.
  Object.assign(r, { merged: false, deleted: true, branch: null })
  const squashed = feature((await refresh(io, session())).view)
  expect(squashed.headline.phase).toBe('done')
  // Unknown is never "not merged": finishing the branch again is not suggested.
  expect(squashed.next).toBe(null)
  expect(squashed.merged).toBe('unknown')
  for (const file of ['detail', 'context'])
    expect(io.written[`${W}/branches/detached-%2Fr/${file}`]).toContain('merged: unknown')
})

test('a shared snapshot follows its original ledger across worktrees until that source is removed', async () => {
  const root = '/r/worktree B'
  for (const { leftoverPlanPath, headerPlan } of [
    { leftoverPlanPath: false, headerPlan: PLAN },
    { leftoverPlanPath: true, headerPlan: `/r/${PLAN}` },
  ]) {
    const files: Record<string, string> = {
      ...spWorld(complete(1), complete(2), complete(3)),
      [LEDGER]: ledger(complete(1), complete(2), complete(3)).replace(PLAN, headerPlan),
      [`${root}/${PLAN}`]: THREE_TASK_PLAN,
    }
    if (leftoverPlanPath) files[`${root}/.superpowers/sdd/auth/plan-path`] = `${PLAN}\n`
    const a = fakeIo(files, git(repo()))
    expect(feature((await refresh(a, session())).view).headline.phase).toBe('review')

    const b = fakeIo(
      files,
      gitBut(repo({ branch: 'feat/other', log: `\0${TIP}\tplan\0\n${PLAN}\0` }), (args) => {
        if (args === 'rev-parse --path-format=absolute --show-toplevel --git-common-dir')
          return `${root}\n/r/.git\n`
        if (args === 'worktree list --porcelain -z')
          return `worktree /r\0HEAD ${HEAD}\0branch refs/heads/feat/auth\0\0worktree ${root}\0HEAD ${TIP}\0branch refs/heads/feat/other\0\0`
        return undefined
      }),
    )
    for (let n = 0; n < 2; n++) {
      const review = feature((await refresh(b, session())).view)
      expect(review.featureId).toBe('auth')
      expect(review.headline.phase).toBe('review')
      expect(review.headline.count).toEqual([3, 3])
      expect(review.sp?.items.map((i) => [i.state, i.reviewed])).toEqual([
        ['complete', true],
        ['complete', true],
        ['complete', true],
      ])
      expect(b.written[`${W}/features/auth/finished`]).toBe('')
      expect(b.written[`${W}/branches/feat%2Fother/watch`]).toContain(`${LEDGER}\n`)
    }

    const unreadable = {
      ...b,
      read: async (path: string) =>
        path === LEDGER ? { ok: false as const, why: 'error' as const } : b.read(path),
    }
    expect(feature((await refresh(unreadable, session())).view).headline.phase).toBe('unknown')
    expect(b.written[`${W}/features/auth/finished`]).toBe('')
    expect((await readNotes(b, W)).notes[0]?.last?.allComplete).toBe(true)

    delete files[LEDGER]
    const done = feature((await refresh(b, session())).view)
    expect(done.headline.phase).toBe('done')
    expect(done.headline.count).toEqual([3, 3])
    expect(done.next?.command).toContain('finishing-a-development-branch')
    expect(b.written[`${W}/features/auth/finished`]).toMatch(/^\d+\n$/)
  }
})

test('a snapshot without plan or absolute source provenance stays unknown until a ledger is read', async () => {
  for (const legacy of [
    { plan: undefined },
    { source: undefined },
    { source: '.superpowers/sdd/auth/progress.md' },
  ]) {
    const files = spWorld(complete(1), complete(2), complete(3))
    const io = fakeIo(files, git(repo()))
    expect(feature((await refresh(io, session())).view).headline.phase).toBe('review')
    const saved = (await readNotes(io, W)).notes[0]
    if (!saved?.last) throw new Error('expected a saved ledger snapshot')
    files[`${W}/features/auth/note.json`] = serializeNote({
      ...saved,
      last: { ...saved.last, ...legacy },
    })
    delete files[LEDGER]
    for (let n = 0; n < 2; n++) {
      const unknown = feature((await refresh(io, session())).view)
      expect(unknown.headline.phase).toBe('unknown')
      expect(io.written[`${W}/features/auth/finished`]).toBe('')
      expect((await readNotes(io, W)).notes[0]?.last?.allComplete).toBe(true)
    }
    files[LEDGER] = ledger(complete(1), complete(2), complete(3))
    expect(feature((await refresh(io, session())).view).headline.phase).toBe('review')
    delete files[LEDGER]
    expect(feature((await refresh(io, session())).view).headline.phase).toBe('done')
    expect(io.written[`${W}/features/auth/finished`]).toMatch(/^\d+\n$/)
  }
})

test('a plan that gains a task after the ledger was first seen marks the headline weak', async () => {
  const files = spWorld(complete(1))
  const io = fakeIo(files, git(repo()))
  expect(feature((await refresh(io, session())).view).headline.weak).toBe(false)
  files[`/r/${PLAN}`] = `${THREE_TASK_PLAN}\n### Task 4: Log out`
  const v = feature((await refresh(io, session())).view)
  expect(v.notices).toContain('plan edited since the build started')
  expect(v.headline.weak).toBe(true)
})

test('Matt manual loop on main: an observed implement with commits after it stays observed', async () => {
  const ticket = '.scratch/demo/issues/01-store.md'
  // As a command names it: repo-relative, absolute, or `./`-led.
  for (const doc of [ticket, `/r/${ticket}`, `./${ticket}`]) {
    const files = {
      '/r/.scratch/demo/issues/01-store.md': '# Store\n\nStatus: ready-for-agent\n',
      '/r/.scratch/demo/issues/02-refresh.md': '# Refresh\n\nStatus: ready-for-agent\n',
    }
    const io = fakeIo(files, git(repo({ branch: 'main', since: `${HEAD}\n${TIP}\n` })))
    const observed = [
      {
        skill: 'mattpocock-skills:implement',
        doc,
        branch: 'main',
        head: START,
        at: '2026-10-06T10:00:00.000Z',
      },
    ]
    const installed = new Set(['mattpocock-skills:implement'])
    for (const facts of [
      session({ observed, skillDocs: [doc], installed }),
      session({ installed }),
    ]) {
      const v = feature((await refresh(io, facts)).view)
      const first = v.matt?.items.find((i) => i.key === '01')
      expect(first?.state).toBe('complete')
      expect(first?.evidence[0]?.strength).toBe('observed')
      expect(v.next?.command).toContain('02-refresh.md')
    }
  }
})

test('Matt implement-spec: pending ticket updates, recorded done a session later, then merged', async () => {
  const files: Record<string, string> = {
    '/r/.scratch/demo/spec.md': '# Demo\n',
    '/r/.scratch/demo/issues/01-store.md': '# Store\n\nStatus: ready-for-agent\n',
    '/r/.scratch/demo/issues/02-refresh.md': '# Refresh\n\nStatus: ready-for-agent\n',
  }
  const r = repo({ branch: 'feat/demo', log: `\0${TIP}\tspec\0\n.scratch/demo/spec.md\0` })
  const base = fakeIo(files, git(r))
  let readable = true
  const io = {
    ...base,
    read: async (path: string) =>
      !readable && path === '/r/.scratch/demo/issues/02-refresh.md'
        ? { ok: false as const, why: 'too-big' as const }
        : base.read(path),
  }
  const installed = new Set(['mattpocock-skills:pr'])
  const observed = [
    {
      skill: 'mattpocock-skills:implement-spec',
      doc: '.scratch/demo/spec.md',
      branch: 'feat/demo',
      head: START,
      at: '2026-10-06T10:00:00.000Z',
    },
  ]
  const started = feature((await refresh(io, session({ observed, installed }))).view)
  expect(started.headline.phase).toBe('build')
  expect(started.next?.text).toContain('check its integration branch before rerunning')

  // 01 recorded done, 02 over the size cap: 02 may still be open, so the build is not over.
  files['/r/.scratch/demo/issues/01-store.md'] = '# Store\n\nStatus: done\n'
  readable = false
  const partial = feature((await refresh(io, session({ installed }))).view)
  expect(partial.headline.phase).toBe('build')
  expect(partial.headline.weak).toBe(true)
  expect(partial.matt?.notes.join('\n')).toContain('ticket statuses update at its end')
  expect(base.written[`${W}/features/demo/finished`]).toBe('')

  files['/r/.scratch/demo/issues/02-refresh.md'] = '# Refresh\n\nStatus: done\n'
  readable = true
  const done = feature((await refresh(io, session({ installed }))).view)
  expect(done.headline.phase).toBe('done')
  expect(done.next?.command).toBe('/mattpocock-skills:pr')
  expect(base.written[`${W}/features/demo/finished`]).toMatch(/^\d+\n$/)

  r.merged = true
  expect(feature((await refresh(io, session({ installed }))).view).headline.phase).toBe('merged')
})

test('a new spec and its plan seen together make one feature holding both', async () => {
  const io = fakeIo({ [`/r/${PLAN}`]: THREE_TASK_PLAN, [`/r/${SPEC}`]: '# Auth\n' }, git(repo()))
  const installed = new Set(['superpowers:subagent-driven-development'])
  const v = feature((await refresh(io, session({ writtenDocs: [SPEC, PLAN], installed }))).view)
  expect(v.docs).toEqual({ spec: SPEC, plan: PLAN })
  expect(v.headline.phase).toBe('plan')
  expect(v.next?.command).toBe(`/superpowers:subagent-driven-development ${PLAN}`)
  expect((await readNotes(io, W)).notes[0]?.docs).toEqual({ spec: SPEC, plan: PLAN })
})

test('a current ledger selects its plan and referenced spec together ahead of history', async () => {
  const OLD = 'docs/superpowers/plans/2026-10-01-auth.md'
  for (const spec of [SPEC, '.scratch/auth/spec.md']) {
    const files = {
      ...spWorld(complete(1)),
      [`/r/${OLD}`]: THREE_TASK_PLAN,
      [`/r/${PLAN}`]: THREE_TASK_PLAN.replace(SPEC, spec),
      [`/r/${spec}`]: '# Auth\n',
      '/r/.scratch/auth/issues/01-store.md': '# Store\n\nStatus: claimed\n',
    }
    const base = fakeIo(files, git(repo({ log: `\0${TIP}\told docs\0\n${OLD}\0${SPEC}\0` })))
    const io = {
      ...base,
      mtimeMs: async (path: string) =>
        path === '/r/.scratch/auth/issues' ? 0 : base.mtimeMs(path),
    }
    // The historical spec must not override this choice again on the next refresh.
    for (let n = 0; n < 2; n++) {
      const v = feature((await refresh(io, session())).view)
      expect(v.docs.plan).toBe(PLAN)
      expect(v.headline.count).toEqual([1, 3])
      expect(v.docs.spec).toBe(spec)
      expect(v.sp?.docs.spec).toBe(spec)
      const watch = io.written[`${W}/branches/feat%2Fauth/watch`] ?? ''
      expect(watch).toContain(`/r/${PLAN}\n`)
      expect(watch).toContain(`/r/${spec}\n`)
      if (spec === '.scratch/auth/spec.md') {
        expect(v.matt?.items.map((item) => [item.key, item.state])).toEqual([['01', 'in-progress']])
        expect(v.matt?.docs.spec).toBe(spec)
        expect(watch).toContain('/r/.scratch/auth/issues\n')
        expect((await readNotes(io, W)).notes[0]?.docs).toEqual({
          plan: PLAN,
          spec,
          tickets: '.scratch/auth/issues/',
        })
      }
    }
  }
})

test('equal write times use the latest explicit occurrence to select the replacement plan', async () => {
  const OLD = 'docs/superpowers/plans/2026-10-01-auth.md'
  // Listing order is replacement, old; the last observed write is replacement.
  const files = {
    [`/r/${PLAN}`]: `**Spec:** ${SPEC}\n\n### Task 1: Replace the old build\n`,
    [`/r/${OLD}`]: THREE_TASK_PLAN,
  }
  const io = fakeIo(files, git(repo()), 5)
  const installed = new Set(['superpowers:subagent-driven-development'])
  const v = feature(
    (await refresh(io, session({ writtenDocs: [PLAN, OLD, PLAN], since: 5, installed }))).view,
  )
  expect(v.docs).toEqual({ plan: PLAN, spec: SPEC })
  expect(v.headline.planned).toBe(1)
  expect(v.next?.command).toBe(`/superpowers:subagent-driven-development ${PLAN}`)
  expect((await readNotes(io, W)).notes[0]?.docs.plan).toBe(PLAN)
})

test('the newest explicit plan start selects the replacement across refreshes', async () => {
  const OLD = 'docs/superpowers/plans/2026-10-01-auth.md'
  const older = {
    skill: 'superpowers:subagent-driven-development',
    doc: OLD,
    branch: 'feat/auth',
    head: START,
    at: '2026-10-06T10:00:00.000Z',
  }
  const replacement = { ...older, doc: PLAN, at: '2026-10-06T11:00:00.000Z' }
  for (const observed of [
    [older, replacement],
    [replacement, older],
  ]) {
    const files: Record<string, string> = {
      ...spWorld(complete(1), complete(2), complete(3)),
      [`/r/${OLD}`]: THREE_TASK_PLAN,
      [`/r/${PLAN}`]: `**Spec:** ${SPEC}\n\n### Task 1: Replace the old build\n`,
      '/r/.superpowers/sdd/auth/plan-path': `${OLD}\n`,
      [LEDGER]: ledger(complete(1), complete(2), complete(3)).replace(PLAN, OLD),
    }
    const io = fakeIo(files, git(repo({ log: `\0${TIP}\told plan\0\n${OLD}\0` })))
    const installed = new Set(['superpowers:subagent-driven-development'])
    expect(
      feature((await refresh(io, session({ observed: [older], skillDocs: [OLD] }))).view).headline
        .phase,
    ).toBe('review')
    expect((await readNotes(io, W)).notes[0]?.last?.allComplete).toBe(true)
    delete files[LEDGER]
    delete files['/r/.superpowers/sdd/auth/plan-path']
    for (const facts of [
      session({
        observed,
        skillDocs: [OLD, ...observed.map((o) => o.doc)],
        writtenDocs: [OLD],
        installed,
      }),
      session({ installed }),
    ]) {
      const v = feature((await refresh(io, facts)).view)
      expect(v.docs).toEqual({ plan: PLAN, spec: SPEC })
      expect(v.headline.phase).toBe('plan')
      expect(v.headline.planned).toBe(1)
      expect(v.next?.command).toBe(`/superpowers:subagent-driven-development ${PLAN}`)
      expect((await readNotes(io, W)).notes[0]?.observed).toContainEqual(replacement)
      expect(io.written[`${W}/branches/feat%2Fauth/watch`]).toBe(`/r/${SPEC}\n/r/${PLAN}\n`)
      expect(io.written[`${W}/features/auth/finished`]).toBe('')
    }
    const fresh = feature((await refresh(io, session({ installed }))).view)
    expect(fresh.notices).not.toContain('plan edited since the build started')
    files['/r/.superpowers/sdd/auth/plan-path'] = `${PLAN}\n`
    files[LEDGER] = ledger(complete(1))
    const built = feature((await refresh(io, session())).view)
    expect(built.headline.phase).toBe('review')
    expect(built.headline.count).toEqual([1, 1])
    expect(built.notices).not.toContain('plan edited since the build started')
    expect((await readNotes(io, W)).notes[0]?.planTasks).toEqual(['Task 1: Replace the old build'])
  }
})

test('a ledger-selected replacement survives removal without resurrecting a historical start', async () => {
  const OLD = 'docs/superpowers/plans/2026-10-01-auth.md'
  const files: Record<string, string> = {
    ...spWorld(complete(1), complete(2), complete(3)),
    [`/r/${OLD}`]: THREE_TASK_PLAN,
    '/r/.superpowers/sdd/auth/plan-path': `${OLD}\n`,
    [LEDGER]: ledger(complete(1), complete(2), complete(3)).replace(PLAN, OLD),
  }
  const oldStart = {
    skill: 'superpowers:subagent-driven-development',
    doc: OLD,
    branch: 'feat/auth',
    head: START,
    at: '2026-10-06T09:00:00.000Z',
  }
  let now = Date.parse('2026-10-06T10:00:00.000Z')
  // A commit of the branch's own, so its tip makes it known not merged.
  const r = repo({ log: `\0${TIP}\tcode\0\nsrc/x.ts\0` })
  const io = { ...fakeIo(files, git(r)), now: async () => now }
  const installed = new Set([
    'superpowers:subagent-driven-development',
    'superpowers:finishing-a-development-branch',
  ])
  const old = feature((await refresh(io, session({ observed: [oldStart], installed }))).view)
  expect(old.docs.plan).toBe(OLD)
  expect(old.headline.phase).toBe('review')

  now = Date.parse('2026-10-06T11:00:00.000Z')
  files['/r/.superpowers/sdd/auth/plan-path'] = `${PLAN}\n`
  files[LEDGER] = ledger(complete(1), complete(2), complete(3))
  const replacement = feature((await refresh(io, session({ installed }))).view)
  expect(replacement.docs).toEqual({ plan: PLAN, spec: SPEC })
  expect(replacement.headline.phase).toBe('review')

  delete files[LEDGER]
  for (let n = 0; n < 2; n++) {
    const done = feature((await refresh(io, session({ installed }))).view)
    expect(done.docs).toEqual({ plan: PLAN, spec: SPEC })
    expect(done.headline.phase).toBe('done')
    expect(done.headline.count).toEqual([3, 3])
    expect(done.sp?.items.map((i) => [i.state, i.reviewed])).toEqual([
      ['complete', true],
      ['complete', true],
      ['complete', true],
    ])
    expect(done.next?.command).toBe('/superpowers:finishing-a-development-branch')
    const saved = (await readNotes(io, W)).notes[0]
    expect(saved?.docs.plan).toBe(PLAN)
    expect(saved?.last?.plan).toBe(PLAN)
    expect(saved?.last?.allComplete).toBe(true)
    expect(saved?.observed).toEqual([oldStart])
    expect(io.written[`${W}/features/auth/finished`]).toMatch(/^\d+\n$/)
  }
})

test('a branch log git could not read rules out no related work', async () => {
  const linked = (docs: Note['docs']) => ({
    [`${W}/features/auth/note.json`]: serializeNote(note({ branches: ['feat/auth'], docs })),
  })
  const worlds = [
    // Superpowers: a linked plan and no progress file.
    { files: { [`/r/${PLAN}`]: THREE_TASK_PLAN, ...linked({ plan: PLAN }) }, skill: 'subagent' },
    // Matt: a linked spec and a ready ticket.
    {
      files: {
        '/r/.scratch/auth/spec.md': '# Auth\n',
        '/r/.scratch/auth/issues/01-store.md': '# Store\n\nStatus: ready-for-agent\n',
        ...linked({ spec: '.scratch/auth/spec.md' }),
      },
      skill: 'mattpocock-skills:implement',
    },
  ]
  const installed = new Set([
    'superpowers:subagent-driven-development',
    'mattpocock-skills:implement',
  ])
  const cut: GitResult = { code: 0, out: `\0${TIP}\tTask 1\0\n`, truncated: true }
  for (const { files, skill } of worlds) {
    for (const log of [undefined, null, cut]) {
      const io = fakeIo(
        { ...files },
        gitBut(repo(), (a) => (a.startsWith('log --name-only') ? log : undefined)),
      )
      const v = feature((await refresh(io, session({ installed }))).view)
      expect(v.headline.weak).toBe(log !== undefined)
      if (log === undefined) expect(v.next?.command).toContain(skill)
      else expect(v.next?.command ?? '').not.toContain(skill)
    }
  }
})

test('a branch or default branch git could not tell is weak, links nothing and is never called detached', async () => {
  const spec = 'docs/superpowers/specs/2026-10-06-x-design.md'
  // label: the view's branch, undefined when git could not tell it.
  const unknowns: [string, (a: string) => GitResult | null | undefined, string | undefined][] = [
    // On main, origin/HEAD's lookup fails: main may well be the default.
    [
      'main',
      (a) => (a === 'symbolic-ref --quiet refs/remotes/origin/HEAD' ? null : undefined),
      'main',
    ],
    // HEAD's full ref comes back cut short.
    [
      'feat/auth',
      (a) =>
        a === 'symbolic-ref --quiet HEAD'
          ? { code: 0, out: 'refs/heads/feat/auth\n', truncated: true }
          : undefined,
      'feat/auth',
    ],
    // Both of HEAD's lookups fail: the branch is unknown, not a detached HEAD.
    [
      'feat/auth',
      (a) =>
        a === 'symbolic-ref --quiet HEAD' || a === 'symbolic-ref --quiet --short HEAD'
          ? null
          : undefined,
      undefined,
    ],
  ]
  for (const [branch, differ, label] of unknowns) {
    const x = note({ id: 'x', branches: ['feat/x'], docs: { spec } })
    const io = fakeIo(
      { [`${W}/features/x/note.json`]: serializeNote(x) },
      gitBut(repo({ branch }), differ),
    )
    const v = feature((await refresh(io, session({ writtenDocs: [spec] }))).view)
    expect(v.featureId).toBe('x')
    expect(v.headline.weak).toBe(true)
    expect(v.branch).toBe(label)
    expect((await readNotes(io, W)).notes[0]?.branches).toEqual(['feat/x'])
    const summaries = Object.keys(io.written).filter((p) => p.startsWith(`${W}/branches/`))
    // No summary key can be told: one under the detached key would never print for this branch.
    if (label === undefined) expect(summaries).toEqual([])
    else {
      const message = io.written[`${W}/branches/${branch.replace('/', '%2F')}/message`]
      expect(message).toContain('design ?')
      expect(message).not.toContain('detached HEAD')
    }
  }
  // Control: a HEAD git confirms detached is named so.
  const io = fakeIo(
    { [`${W}/features/x/note.json`]: serializeNote(note({ id: 'x', docs: { spec } })) },
    git(repo({ branch: null })),
  )
  expect(feature((await refresh(io, session({ writtenDocs: [spec] }))).view).branch).toBe(null)
  expect(io.written[`${W}/branches/detached-%2Fr/message`]).toContain('detached HEAD')
})

test('a leftover ledger whose progress file does not name its plan never displaces the linked feature', async () => {
  // Its progress file names another plan, or is gone.
  const progresses: Record<string, string>[] = [
    { '/r/.superpowers/sdd/b/progress.md': ledger(complete(1)) },
    {},
  ]
  for (const progress of progresses) {
    const files: Record<string, string> = {
      [`/r/${PLAN}`]: THREE_TASK_PLAN,
      [`${W}/features/auth/note.json`]: serializeNote(
        note({ branches: ['feat/auth'], docs: { plan: PLAN } }),
      ),
      '/r/.superpowers/sdd/b/plan-path': 'docs/superpowers/plans/2026-10-05-b.md\n',
      ...progress,
    }
    const v = feature((await refresh(fakeIo(files, git(repo())), session())).view)
    expect(v.featureId).toBe('auth')
  }
})

test('a plan over the size cap or not text is unsupported, never back in design', async () => {
  for (const why of ['too-big', 'not-text'] as const) {
    const base = fakeIo(spWorld(complete(1)), git(repo()))
    let readable = true
    const io = {
      ...base,
      read: async (path: string) =>
        !readable && path === `/r/${PLAN}` ? { ok: false as const, why } : base.read(path),
    }
    expect(feature((await refresh(io, session())).view).headline.phase).toBe('build')
    readable = false
    const v = feature((await refresh(io, session())).view)
    expect(v.headline.phase).toBe('unknown')
    expect(v.sp?.unsupported).toContain(`unsupported format (${why})`)
    expect(base.written[`${W}/branches/feat%2Fauth/detail`]).toContain(why)
    expect((await readNotes(io, W)).notes[0]?.last?.tasks['1']?.state).toBe('complete')
  }
})

test('an observed implement whose commits git cannot count is unknown, never 0 commits', async () => {
  const files = { '/r/.scratch/demo/issues/01-store.md': '# Store\n\nStatus: ready-for-agent\n' }
  const r = repo({ branch: 'main', since: `${HEAD}\n` })
  const observed = [
    {
      skill: 'mattpocock-skills:implement',
      doc: '.scratch/demo/issues/01-store.md',
      branch: 'main',
      head: START,
      at: '2026-10-06T10:00:00.000Z',
    },
  ]
  const answer = git(r)
  let counted = true
  const io = fakeIo(files, (args) =>
    !counted && args.join(' ').startsWith('log --format=%H') ? null : answer(args),
  )
  const skillDocs = observed.map((o) => o.doc)
  const seen = feature((await refresh(io, session({ observed, skillDocs }))).view).matt?.items[0]
  expect(seen?.state).toBe('complete')
  counted = false
  const v = feature((await refresh(io, session())).view)
  expect(v.matt?.items[0]?.state).toBe('unknown')
  expect(v.matt?.items[0]?.evidence[0]?.text).toContain('commits since unknown')
  expect(v.headline.weak).toBe(true)
})

// A start whose HEAD git could not read saves no head: its work is unknown, never every commit on HEAD.
test('a saved implement start with no known head is unknown work, never built here', async () => {
  const ticket = '.scratch/demo/issues/01-store.md'
  const files = {
    [`/r/${ticket}`]: '# Store\n\nStatus: ready-for-agent\n',
    [`${W}/features/demo/note.json`]: serializeNote(
      note({
        id: 'demo',
        branches: ['main'],
        docs: { tickets: '.scratch/demo/issues/' },
        observed: [
          {
            skill: 'mattpocock-skills:implement',
            doc: ticket,
            branch: 'main',
            at: '2026-10-06T10:00:00.000Z',
          },
        ],
      }),
    ),
  }
  const io = fakeIo(files, git(repo({ branch: 'main', since: `${HEAD}\n${TIP}\n` })))
  const v = feature((await refresh(io, session())).view)
  expect(v.notices).toEqual([])
  expect(v.matt?.items[0]?.state).toBe('unknown')
  expect(v.matt?.items[0]?.evidence[0]?.text).toContain('commits since unknown')
})

test('a ticket reading otherwise on another branch differs there; branches git cannot list are unknown', async () => {
  const ticket = '.scratch/demo/issues/01-store.md'
  const files = { ['/r/' + ticket]: '# Store\n\nStatus: ready-for-agent\n' }
  let listed = true
  const copies = { [`refs/heads/main:${ticket}`]: '# Store\n\nStatus: done\n' }
  const io = fakeIo(
    files,
    gitBut(repo({ copies }), (a) =>
      a === 'for-each-ref --format=%(refname) refs/heads/' && !listed ? null : undefined,
    ),
  )
  const facts = session({ writtenDocs: [ticket] })
  const whole = feature((await refresh(io, facts)).view)
  expect(whole.notices).toEqual([])
  expect(whole.matt?.items.map((i) => [i.key, i.state, i.differsOn])).toEqual([
    ['01', 'open', ['main']],
  ])
  listed = false
  const v = feature((await refresh(io, facts)).view)
  expect(v.matt?.items.map((i) => i.state)).toEqual(['open'])
  expect(v.notices).toEqual([expect.stringContaining('could not read the other branches')])
})

test('a Matt spec whose tickets git cannot list suggests no to-tickets and is weak', async () => {
  const files = { '/r/.scratch/demo/spec.md': '# Demo\n' }
  const answer = git(repo())
  let listed = true
  const io = fakeIo(files, (args) => (!listed && args[0] === 'ls-tree' ? null : answer(args)))
  const facts = session({
    writtenDocs: ['.scratch/demo/spec.md'],
    installed: new Set(['mattpocock-skills:to-tickets', 'mattpocock-skills:ask-matt']),
  })
  expect(feature((await refresh(io, facts)).view).next?.command).toContain('to-tickets')
  listed = false
  const v = feature((await refresh(io, facts)).view)
  expect(v.headline.weak).toBe(true)
  expect(v.headline.count).toBeUndefined()
  expect(v.matt?.total).toBeUndefined()
  expect(v.matt?.phase).toBe('unknown')
  expect(v.next?.command ?? '').not.toContain('to-tickets')
})

test('two notes linked to the branch ask to choose and write no note; a chosen one is shown', async () => {
  const files = {
    [`${W}/features/a/note.json`]: serializeNote(note({ id: 'a', branches: ['feat/auth'] })),
    [`${W}/features/b/note.json`]: serializeNote(note({ id: 'b', branches: ['feat/auth'] })),
  }
  const io = fakeIo(files, git(repo()))
  const { view } = await refresh(io, session())
  expect(view?.kind === 'choose' && view.candidates.map((c) => c.id).sort()).toEqual(['a', 'b'])
  expect(io.written[`${W}/branches/feat%2Fauth/message`]).toContain('2 features could match')
  expect(Object.keys(io.written).filter((p) => p.includes('/features/'))).toEqual([])

  const chosen = { id: 'b', commonDir: '/r/.git', branchRef: 'refs/heads/feat/auth', root: '/r' }
  expect(feature((await refresh(io, session({ chosen }))).view).featureId).toBe('b')
})

test('a corrupt note.json for the feature is rebuilt and the view says so', async () => {
  const files = { ...spWorld(complete(1)), [`${W}/features/auth/note.json`]: '{' }
  const io = fakeIo(files, git(repo()))
  const v = feature((await refresh(io, session())).view)
  expect(v.notices.join('\n')).toContain('earlier record was unreadable')
  expect((await readNotes(io, W)).notes.map((n) => n.id)).toEqual(['auth'])
})

test('outside a repo nothing is shown or written', async () => {
  const io = fakeIo(spWorld(complete(1)), () => null)
  expect(await refresh(io, session())).toEqual({ view: null, facts: null })
  expect(io.written).toEqual({})
})
