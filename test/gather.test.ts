import { expect, test } from 'claude-code/testing'
import { classifyDoc, resolveFeature } from '../src/feature'
import {
  branchCommits,
  buildBranch,
  commitsSince,
  ledgerDirs,
  mergedState,
  noteRefs,
  readNotes,
  readTickets,
  relatedKeys,
  taskNumbers,
} from '../src/gather'
import { parseTicket, readMatt } from '../src/matt'
import { serializeNote } from '../src/notes'
import type { GitResult, Note, RepoFacts } from '../src/types'
import { fakeIo } from './fake-io'
import { BOLD_READY_TICKET } from './fixtures/matt'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const FACTS: RepoFacts = {
  root: '/r',
  commonDir: '/r/.git',
  mainRoot: '/r',
  branch: 'feat/a',
  branchRef: 'refs/heads/feat/a',
  head: A,
  defaultBranch: 'main',
  defaultName: 'main',
  defaultRef: 'refs/heads/main',
}
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
const commit = (subject: string) => ({ sha: A, subject, files: [] })

// git cat-file --batch answering `blobs` (spec to text; absent specs are missing), sizes in bytes.
const batch =
  (blobs: Record<string, string>) =>
  (stdin = '') =>
    stdin
      .split('\n')
      .filter((spec) => spec !== '')
      .map((spec) => {
        const text = blobs[spec]
        if (text === undefined) return `${spec} missing\n`
        return `${A} blob ${new TextEncoder().encode(text).length}\n${text}\n`
      })
      .join('')

test('branchCommits reads each commit of the branch with its subject and files', async () => {
  const log = 'log --name-only -z --format=%x00%H%x09%s --end-of-options refs/heads/main..HEAD'
  // git's -z layout, an empty commit between: names as they are, `ä` not C-quoted.
  const out = `\0${A}\tfeat: store (Task 1)\0\n.scratch/ä/spec.md\0src/b.ts\0\0${A}\tempty\0\0${B}\tfix\tthing\0\n.scratch/x/issues/01-a.md\0`
  const io = fakeIo({}, (args) => (args.join(' ') === log ? out : null))
  const commits = await branchCommits(io, FACTS)
  expect(commits).toEqual([
    { sha: A, subject: 'feat: store (Task 1)', files: ['.scratch/ä/spec.md', 'src/b.ts'] },
    { sha: A, subject: 'empty', files: [] },
    { sha: B, subject: 'fix\tthing', files: ['.scratch/x/issues/01-a.md'] },
  ])
  // Spec section 4 rule 5: a committed document with no note starts its feature.
  const docs = (commits ?? []).flatMap((c) => c.files.flatMap((f) => classifyDoc(f, '/r') ?? []))
  const identity = resolveFeature({
    branch: 'feat/a',
    isDefault: false,
    notes: [],
    ledgerPlans: [],
    skillDocs: [],
    writtenDocs: [],
    commitDocs: docs.slice(0, 1),
    planSpecs: {},
    docTimes: {},
  })
  expect(identity.kind === 'one' && [identity.id, identity.create?.path]).toEqual([
    'ä',
    '.scratch/ä/spec.md',
  ])
  const cut = fakeIo({}, (args) =>
    args.join(' ') === log ? { code: 0, out, truncated: true } : null,
  )
  expect(await branchCommits(cut, FACTS)).toBe(null)
  expect(await branchCommits(io, { ...FACTS, branch: 'main', branchRef: 'refs/heads/main' })).toBe(
    null,
  )
})

test('a default branch named like an option never reaches git as one', async () => {
  const name = '--output=/tmp/probe'
  const facts = {
    ...FACTS,
    defaultBranch: name,
    defaultName: name,
    defaultRef: `refs/heads/${name}`,
  }
  const calls: string[][] = []
  const io = fakeIo({}, (args) => {
    calls.push(args)
    return args[0] === 'log' ? `\0${A}\tx\0` : ''
  })
  expect(await branchCommits(io, facts)).toEqual([{ sha: A, subject: 'x', files: [] }])
  expect(await mergedState(io, note({ tips: { 'feat/a': B } }), facts)).toBe(true)
  // git reads options up to --end-of-options; the stored name only ever comes after it, inside a full ref.
  const named = calls.flatMap((args) =>
    args.flatMap((arg, i) =>
      arg.includes(name) ? [[arg.startsWith('refs/'), args.indexOf('--end-of-options') < i]] : [],
    ),
  )
  expect(named).toEqual([
    [true, true],
    [true, true],
  ])
})

test('taskNumbers lists each task a subject names, once, in order', () => {
  const subjects = ['fix task 3 review', 'feat: token store (Task 1)', 'Task 1 again', 'Tasks 9']
  expect(taskNumbers(subjects.map(commit))).toEqual([1, 3])
})

test('relatedKeys matches a ticket number or slug only as a whole word', () => {
  const tickets = ['01-token-store.md', '02-refresh.md'].map((name) =>
    parseTicket(`.scratch/f/issues/${name}`, ''),
  )
  const keys = (subject: string) => relatedKeys([commit(subject)], tickets)
  expect(keys('implement #02 now')).toEqual(['02'])
  expect(keys('finish token-store')).toEqual(['01'])
  expect(keys('bump 2026')).toEqual([])
})

test('a ticket slug in any script relates its commit and leaves the frontier', () => {
  const tickets = ['01-ä.md', '02-b.md'].map((name) =>
    parseTicket(`.scratch/f/issues/${name}`, 'Status: ready-for-agent'),
  )
  const related = relatedKeys([commit('implement ä')], tickets)
  expect(related).toEqual(['01'])
  expect(relatedKeys([commit('implement äx'), commit('xä')], tickets)).toEqual([])
  const matt = readMatt({
    folder: '.scratch/f',
    hasSpec: true,
    hasMap: false,
    tickets,
    unreadable: [],
    observed: [],
    relatedKeys: related,
  })
  expect(matt.frontier).toEqual(['02'])
})

test('commitsSince counts commits after an observed head, or all without one', async () => {
  const io = fakeIo({}, (args) => {
    const answers: Record<string, string> = {
      'log --format=%H abc..HEAD': `${A}\n${B}\n`,
      'log --format=%H HEAD': `${A}\n${B}\n${'c'.repeat(40)}\n`,
    }
    return answers[args.join(' ')] ?? null
  })
  expect(await commitsSince(io, 'abc')).toBe(2)
  expect(await commitsSince(io, null)).toBe(3)
  // Missing evidence is unknown, not 0 commits: git failed, its output was cut, or the head is no commit id.
  const cut = fakeIo({}, () => ({ code: 0, out: `${A}\n`, truncated: true }))
  expect(await commitsSince(cut, 'abc')).toBe(null)
  expect(await commitsSince(io, 'def')).toBe(null)
  expect(await commitsSince(io, '--all')).toBe(null)
})

test('ledgerDirs finds every ledger folder naming a plan and skips the flat ledger', async () => {
  const sdd = '/r/.superpowers/sdd'
  const io = fakeIo(
    {
      [`${sdd}/a/plan-path`]: 'docs/superpowers/plans/a.md\n',
      [`${sdd}/b/plan-path`]: '  docs/superpowers/plans/b.md  \r\nmore\n',
      [`${sdd}/c/progress.md`]: '# SDD ledger — plan: docs/superpowers/plans/c.md\n',
      [`${sdd}/progress.md`]: '# SDD ledger — plan: docs/superpowers/plans/old.md\n',
    },
    () => null,
  )
  expect(await ledgerDirs(io, '/r')).toEqual([
    { dir: `${sdd}/a`, plan: 'docs/superpowers/plans/a.md' },
    { dir: `${sdd}/b`, plan: 'docs/superpowers/plans/b.md' },
  ])
})

test('readNotes lists corrupt notes as invalid and skips forgotten ones', async () => {
  const root = '/r/.git/whereami'
  const auth = note({ id: 'auth' })
  const io = fakeIo(
    {
      [`${root}/features/auth/note.json`]: serializeNote(auth),
      [`${root}/features/auth/finished`]: '1791200000\n',
      [`${root}/features/broken/note.json`]: '{"version": 1, "id": ',
      [`${root}/features/gone/note.json`]: serializeNote(note({ id: 'gone' })),
      [`${root}/features/gone/forget`]: '',
      [`${root}/features/open/note.json`]: serializeNote(note({ id: 'open' })),
      [`${root}/features/open/finished`]: '',
    },
    () => null,
  )
  expect(await readNotes(io, root)).toEqual({
    notes: [auth, note({ id: 'open' })],
    invalid: ['broken'],
    finished: { auth: 1791200000 },
  })
})

test('readNotes and noteRefs mark finished only a feature with its own finished file', async () => {
  // Ids that are also names on every object's prototype.
  const root = '/r/.git/whereami'
  const io = fakeIo(
    {
      [`${root}/features/constructor/note.json`]: serializeNote(note({ id: 'constructor' })),
      [`${root}/features/__proto__/note.json`]: serializeNote(note({ id: '__proto__' })),
      [`${root}/features/__proto__/finished`]: '1791200000\n',
    },
    () => null,
  )
  const { notes, finished } = await readNotes(io, root)
  expect(Object.entries(finished)).toEqual([['__proto__', 1791200000]])
  const refs = await noteRefs(io, '/r', notes, finished)
  expect(refs.map((r) => [r.id, r.finished])).toEqual([
    ['constructor', false],
    ['__proto__', true],
  ])
  // A plain object from elsewhere: inherited names are no finished file.
  expect((await noteRefs(io, '/r', notes, {})).map((r) => r.finished)).toEqual([false, false])
})

test('noteRefs dates a note by its newest document and marks it finished', async () => {
  const times: Record<string, number> = {
    '/r/spec.md': 5,
    '/r/.scratch/f/issues': 9,
    '/r/.scratch/f/map.md': 3,
  }
  const io = { ...fakeIo({}, () => null), mtimeMs: async (path: string) => times[path] ?? null }
  const docs = {
    spec: 'spec.md',
    plan: 'gone.md',
    tickets: '.scratch/f/issues/',
    map: '.scratch/f/map.md',
  }
  const refs = await noteRefs(io, '/r', [note({ id: 'a', docs }), note({ id: 'b' })], { a: 1 })
  expect(refs.map((r) => [r.id, r.lastChange, r.finished])).toEqual([
    ['a', 9, true],
    ['b', 0, false],
  ])
})

test('buildBranch picks the note branch with the newest tip, else the current branch', async () => {
  const refs = 'for-each-ref --format=%(committerdate:unix)%09%(refname)'
  const io = fakeIo({}, (args) =>
    args.join(' ') === `${refs} refs/heads/feat/a refs/heads/feat/b`
      ? '100\trefs/heads/feat/a\n200\trefs/heads/feat/b\n'
      : null,
  )
  expect(await buildBranch(io, note({ branches: ['main', 'feat/a', 'feat/b'] }), FACTS)).toBe(
    'refs/heads/feat/b',
  )
  expect(await buildBranch(io, note({ branches: ['main'] }), FACTS)).toBe('refs/heads/feat/a')
})

test('buildBranch falls back to the current branch only when git says no note branch exists', async () => {
  // An integration branch git could not list may hold the newest tickets: where to read them is unknown.
  const listing = (answer: GitResult) =>
    buildBranch(
      fakeIo({}, (args) => (args[0] === 'for-each-ref' ? answer : null)),
      note({ branches: ['feat/int'] }),
      FACTS,
    )
  expect(await listing({ code: 0, out: '', truncated: false })).toBe('refs/heads/feat/a')
  expect(await listing({ code: 128, out: '', truncated: false })).toBe(null)
  expect(await listing({ code: 0, out: '100\trefs/heads/feat/int\n', truncated: true })).toBe(null)
})

const LS_TREE =
  'ls-tree -z --name-only --full-tree --end-of-options refs/heads/feat/a -- .scratch/f/issues/'
const PATH = '.scratch/f/issues/01-store.md'
const BUILD = `refs/heads/feat/a:${PATH}`
const OTHER = `refs/heads/feat/b:${PATH}`

// git with 01-store.md committed on feat/a: its ls-tree answer, then cat-file's.
const committedGit =
  (tree: GitResult | string | null, cat: (stdin: string) => GitResult | string) =>
  (args: string[], stdin = '') =>
    args.join(' ') === LS_TREE ? tree : args.join(' ') === 'cat-file --batch' ? cat(stdin) : null

test('readTickets is null when git cannot tell which tickets are committed or what they hold', async () => {
  const files = { [`/r/${PATH}`]: 'Status: claimed' }
  const read = (git: ReturnType<typeof committedGit>) =>
    readTickets(fakeIo(files, git), '.scratch/f', FACTS, 'refs/heads/feat/a', ['feat/b'])
  const blobs = batch({ [BUILD]: BOLD_READY_TICKET, [OTHER]: 'Status: done' })
  const whole = await read(committedGit(`${PATH}\0`, blobs))
  expect(whole?.tickets.map((t) => [t.path, t.status, t.differsOn])).toEqual([
    [PATH, 'ready-for-agent', ['feat/b']],
  ])
  expect(whole?.unreadable).toEqual([])
  // The build branch's record is whole; feat/b's, after it, is cut at the 4 MiB cap.
  const delivered: string[] = []
  const cut = (stdin: string) => {
    delivered.push(stdin)
    return { code: 0, out: blobs(stdin).slice(0, -3), truncated: true }
  }
  expect(await read(committedGit(`${PATH}\0`, cut))).toBe(null)
  expect(delivered).toEqual([`${BUILD}\n${OTHER}\n`])
  // A failed or cut listing is no answer, never an empty one that hands the build branch's tickets to the
  // working tree.
  expect(await read(committedGit(null, blobs))).toBe(null)
  const cutTree = { code: 0, out: `${PATH}\0`, truncated: true }
  expect(await read(committedGit(cutTree, blobs))).toBe(null)
})

test('readTickets before the first commit reads the working tree once git says the branch is not there', async () => {
  // ls-tree fails on an unborn branch; only show-ref's exit 1 makes its committed tickets none.
  const read = (showRef: GitResult) =>
    readTickets(
      fakeIo({ '/r/.scratch/f/issues/01-new.md': 'Status: ready-for-agent' }, (args) =>
        args.join(' ') === 'show-ref --verify --quiet refs/heads/feat/a' ? showRef : null,
      ),
      '.scratch/f',
      FACTS,
      'refs/heads/feat/a',
      [],
    )
  const fresh = await read({ code: 1, out: '', truncated: false })
  expect(fresh?.tickets.map((t) => [t.path, t.status])).toEqual([
    ['.scratch/f/issues/01-new.md', 'ready-for-agent'],
  ])
  expect(await read({ code: 0, out: '', truncated: false })).toBe(null)
  expect(await read({ code: 128, out: '', truncated: false })).toBe(null)
})

test('a committed ticket whose name holds a line break is unreadable, never dropped', async () => {
  // The odd name comes first: sent to cat-file, its two lines would shift the answer for the done ticket too.
  const odd = '.scratch/f/issues/01-a\nb.md'
  const done = '.scratch/f/issues/02-done.md'
  const blobs = batch({ [`refs/heads/feat/a:${done}`]: 'Status: done' })
  const io = fakeIo({}, committedGit(`${odd}\0${done}\0`, blobs))
  const read = await readTickets(io, '.scratch/f', FACTS, 'refs/heads/feat/a', ['feat/b'])
  expect(read?.tickets.map((t) => [t.path, t.status])).toEqual([[done, 'done']])
  expect(read?.unreadable).toEqual([
    { path: odd, why: 'line break in name' },
    { path: odd, why: 'line break in name', branch: 'feat/b' },
  ])
})

test('readTickets reports unreadable comparison copies even when the build copy is unreadable', async () => {
  const copy = (b: string) => `refs/heads/${b}:${PATH}`
  // feat/b's copy is binary, feat/c has none, feat/d's record (the last) ends early while git reports success.
  for (const text of [BOLD_READY_TICKET, 'x'.repeat(1048577)]) {
    const blobs = batch({
      [BUILD]: text,
      [OTHER]: 'Status: done\0',
      [copy('feat/d')]: 'x',
    })
    const cat = (stdin: string) => ({ code: 0, out: blobs(stdin).slice(0, -2), truncated: false })
    const io = fakeIo({}, committedGit(`${PATH}\0`, cat))
    const branches = ['feat/b', 'feat/c', 'feat/d']
    const read = await readTickets(io, '.scratch/f', FACTS, 'refs/heads/feat/a', branches)
    expect(read?.tickets.map((t) => [t.path, t.status, t.differsOn])).toEqual(
      text === BOLD_READY_TICKET ? [[PATH, 'ready-for-agent', undefined]] : [],
    )
    expect(read?.unreadable).toEqual([
      ...(text === BOLD_READY_TICKET ? [] : [{ path: PATH, why: 'too-big' }]),
      { path: PATH, why: 'not-text', branch: 'feat/b' },
      { path: PATH, why: 'error', branch: 'feat/d' },
    ])
  }
})

test('mergedState: ancestor merged, live branch not merged, deleted branch unknown', async () => {
  const exit = (code: number): GitResult => ({ code, out: '', truncated: false })
  const state = (ancestor: GitResult, branch: GitResult) =>
    mergedState(
      fakeIo({}, (args) => {
        const cmd = args.join(' ')
        if (cmd === `merge-base --is-ancestor --end-of-options ${B} refs/heads/main`)
          return ancestor
        return cmd === 'show-ref --verify --quiet refs/heads/feat/a' ? branch : null
      }),
      note({ tips: { 'feat/a': B } }),
      FACTS,
    )
  expect(await state(exit(0), exit(1))).toBe(true)
  expect(await state(exit(1), exit(0))).toBe(false)
  expect(await state(exit(1), exit(1))).toBe('unknown')
  expect(await state(exit(128), exit(0))).toBe('unknown')
  // A cut answer is none, whatever its exit code says.
  expect(await state({ code: 0, out: '', truncated: true }, exit(1))).toBe('unknown')
  expect(await state(exit(1), { code: 0, out: '', truncated: true })).toBe('unknown')
})
