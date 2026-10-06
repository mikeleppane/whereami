import { expect, mock, type TestBody, test } from 'claude-code/testing'
import { branchCommits, buildBranch, mergedState, readTickets } from '../src/gather'
import { branchOf, parseCatFileBatch, repoFacts } from '../src/io'
import { refresh } from '../src/refresh'
import type { GitResult, Note } from '../src/types'
import { fakeIo } from './fake-io'
import { catFile } from './fixtures/repo'
import { posix } from './world'

type World = {
  where?: string
  branch?: string
  branchShort?: string
  currentRef?: GitResult
  head?: string
  originHead?: string
  // git's shortened name for origin/HEAD's target, when it is not `origin/<originHead>`.
  originShort?: string
  originRef?: GitResult
  heads?: string[]
  // show-ref answers for refs whose probe does not answer plainly.
  probes?: Record<string, GitResult>
  worktrees?: GitResult | string
  // The HEAD probe's answer, when it is not the commit or git's exit 1 before the first commit.
  headProbe?: GitResult
}

const ABSENT: GitResult = { code: 1, out: '', truncated: false }

// git as a repo at /r answers: the commands repoFacts runs, keyed by their arguments. A missing symbolic or
// verified ref exits 1, as git does.
const repo = (w: World, files: Record<string, string> = {}) =>
  fakeIo(files, (args) => {
    const origin = w.originHead === undefined ? [] : [`refs/remotes/origin/${w.originHead}`]
    const refs = [...(w.heads ?? ['main']).map((h) => `refs/heads/${h}`), ...origin]
    if (args.slice(0, 3).join(' ') === 'show-ref --verify --quiet') {
      const ref = args[3] ?? ''
      return w.probes?.[ref] ?? (refs.includes(ref) ? '' : ABSENT)
    }
    const answers: Record<string, GitResult | string | null> = {
      'rev-parse --path-format=absolute --show-toplevel --git-common-dir':
        w.where ?? '/r\n/r/.git\n',
      'symbolic-ref --quiet --short HEAD':
        w.branch === undefined ? ABSENT : `${w.branchShort ?? w.branch}\n`,
      'symbolic-ref --quiet HEAD':
        w.currentRef ?? (w.branch === undefined ? ABSENT : `refs/heads/${w.branch}\n`),
      'rev-parse --verify --quiet HEAD':
        w.headProbe ?? (w.head === undefined ? ABSENT : `${w.head}\n`),
      'symbolic-ref --quiet --short refs/remotes/origin/HEAD':
        w.originHead === undefined ? ABSENT : `${w.originShort ?? `origin/${w.originHead}`}\n`,
      'symbolic-ref --quiet refs/remotes/origin/HEAD':
        w.originRef ?? (origin[0] === undefined ? ABSENT : `${origin[0]}\n`),
      'worktree list --porcelain -z':
        w.worktrees ??
        `worktree /r\0HEAD ${w.head ?? '0'.repeat(40)}\0branch refs/heads/main\0\0worktree /r/wt\0detached\0\0`,
    }
    return answers[args.join(' ')] ?? null
  })

const SHA = 'a'.repeat(40)

test('parseCatFileBatch walks sizes in bytes and tells each spec apart', () => {
  // `ä\n` is 3 bytes: counted in characters, the walk would cut it short and lose every later spec.
  const out = [
    `${SHA} blob 3\nä\n\n`,
    `${SHA} blob 5\nplain\n`,
    'main:gone.md missing\n',
    `${SHA} blob 3\na\0b\n`,
    `${SHA} blob 1048577\n${'x'.repeat(1048577)}\n`,
    `${SHA} blob 10\nabc`,
  ].join('')
  const specs = ['a', 'b', 'main:gone.md', 'nul', 'big', 'cut', 'after']
  // Texts cut short, so a failure never prints the 1 MiB blob.
  const read = [...parseCatFileBatch(out, specs)].map(([spec, r]) => [
    spec,
    r.ok ? { text: r.text.slice(0, 9) } : r.why,
  ])
  expect(Object.fromEntries(read)).toEqual({
    a: { text: 'ä\n' },
    b: { text: 'plain' },
    'main:gone.md': 'missing',
    nul: 'not-text',
    big: 'too-big',
    cut: 'error',
    after: 'error',
  })
})

test('repoFacts on a branch', async () => {
  expect(await repoFacts(repo({ branch: 'feat/a', head: SHA, originHead: 'trunk' }))).toEqual({
    root: '/r',
    commonDir: '/r/.git',
    mainRoot: '/r',
    branch: 'feat/a',
    branchRef: 'refs/heads/feat/a',
    head: SHA,
    defaultBranch: 'trunk',
    defaultName: 'trunk',
    // No local trunk: revisions use origin's.
    defaultRef: 'refs/remotes/origin/trunk',
  })
  const local = await repoFacts(repo({ branch: 'feat/a', head: SHA, originHead: 'main' }))
  expect(local?.defaultRef).toBe('refs/heads/main')
})

test('repoFacts on a detached HEAD has no branch', async () => {
  const facts = await repoFacts(repo({ head: SHA }))
  expect(facts?.branch).toBe(null)
  expect(facts?.head).toBe(SHA)
})

test('repoFacts before the first commit has no head', async () => {
  const facts = await repoFacts(repo({ branch: 'main' }))
  expect(facts?.branch).toBe('main')
  expect(facts?.head).toBe(null)
})

// A failed or cut HEAD probe is unknown, never "no commits": later work would count every commit since the start.
test('repoFacts leaves the head unknown when git cannot read HEAD', async () => {
  const failed = { code: 128, out: '', truncated: false }
  const cut = { code: 0, out: SHA.slice(0, 7), truncated: true }
  for (const headProbe of [failed, cut]) {
    // The repo and its branch are still known.
    const facts = await repoFacts(repo({ branch: 'main', headProbe }))
    expect(facts).toEqual(
      expect.objectContaining({ root: '/r', commonDir: '/r/.git', branch: 'main' }),
    )
    expect(facts?.head).toBe(undefined)
  }
})

// A skill start records its branch: detached (exit 1) is null, a lookup git fails or cuts is unknown.
test('branchOf tells a detached HEAD from a branch git cannot read', async () => {
  const of = (r: GitResult) =>
    branchOf(
      fakeIo({}, (args) => (args.join(' ') === 'symbolic-ref --quiet --short HEAD' ? r : null)),
    )
  expect(await of({ code: 0, out: 'feat/a\n', truncated: false })).toBe('feat/a')
  expect(await of({ code: 1, out: '', truncated: false })).toBe(null)
  expect(await of({ code: 128, out: '', truncated: false })).toBe(undefined)
  expect(await of({ code: 0, out: 'feat/', truncated: true })).toBe(undefined)
})

test('repoFacts falls back to master without origin/HEAD or main', async () => {
  const facts = await repoFacts(repo({ branch: 'x', head: SHA, heads: ['master', 'x'] }))
  expect(facts?.defaultBranch).toBe('master')
  expect(facts?.defaultRef).toBe('refs/heads/master')
})

test('repoFacts leaves the default ref unknown when git cannot say the local branch is absent', async () => {
  const failed: GitResult = { code: 128, out: '', truncated: false }
  const cut: GitResult = { code: 1, out: '', truncated: true }
  // origin's trunk exists; whether a local trunk does is unknown, so neither is picked.
  const trunk = (probe: GitResult) =>
    repoFacts(
      repo({ branch: 'x', head: SHA, originHead: 'trunk', probes: { 'refs/heads/trunk': probe } }),
    )
  expect((await trunk(failed))?.defaultRef).toBe(null)
  expect((await trunk(cut))?.defaultRef).toBe(null)
  // Without origin/HEAD, a failed main probe never falls through to master; the name keeps the hook's fall-through.
  const facts = await repoFacts(
    repo({ branch: 'x', head: SHA, heads: ['master'], probes: { 'refs/heads/main': failed } }),
  )
  expect([facts?.defaultBranch, facts?.defaultRef]).toEqual(['master', null])
})

test('ref collisions keep display keys but never change the build inventory or default-branch decisions', async () => {
  const path = '.scratch/f/issues/01-store.md'
  const failed: GitResult = { code: 128, out: '', truncated: false }
  const cut: GitResult = { code: 0, out: 'refs/heads/feat/a\n', truncated: true }
  const tickets: Record<string, string> = {
    'refs/heads/feat/a': 'Status: claimed',
    'refs/heads/feat/int': 'Status: done',
    'refs/heads/main': 'Status: ready-for-agent',
    'refs/remotes/origin/main': 'Status: ready-for-agent',
    HEAD: 'Status: needs-info',
  }
  const saved: Note = {
    version: 1,
    id: 'f',
    branches: [],
    unlinked: [],
    tips: { main: SHA },
    docs: {},
    planTasks: [],
    observed: [],
    last: null,
  }
  const rows: (World & {
    branches: string[]
    build: string | null
    base: string | null
    status: string | null
    differsOn?: string[]
    defaultUnknown?: boolean
  })[] = [
    {
      branchShort: 'feat/a',
      originShort: 'remotes/origin/main',
      heads: ['origin/main', 'main', 'feat/a', 'feat/int'],
      branches: ['main', 'feat/int'],
      build: 'refs/heads/feat/int',
      base: 'refs/heads/main',
      status: 'done',
      differsOn: ['main', 'feat/a'],
    },
    {
      branchShort: 'heads/feat/a',
      originShort: 'origin/main',
      heads: ['feat/a'],
      branches: [],
      build: 'refs/heads/feat/a',
      base: 'refs/remotes/origin/main',
      status: 'claimed',
    },
    {
      branches: [],
      build: 'refs/heads/feat/a',
      base: 'refs/heads/main',
      status: 'claimed',
      differsOn: ['main', 'feat/int'],
    },
    ...[failed, cut, { ...ABSENT, truncated: true }].map((currentRef) => ({
      currentRef,
      branches: [],
      build: null,
      base: 'refs/heads/main',
      status: null,
    })),
    {
      branch: undefined,
      branches: [],
      build: 'refs/heads/main',
      base: 'refs/heads/main',
      status: 'ready-for-agent',
      differsOn: ['feat/a', 'feat/int'],
    },
    {
      currentRef: failed,
      branches: ['feat/int'],
      build: 'refs/heads/feat/int',
      base: 'refs/heads/main',
      status: 'done',
      differsOn: ['main', 'feat/a'],
    },
    ...[failed, { ...ABSENT, truncated: true }].map((probe) => ({
      probes: { 'refs/heads/main': probe },
      branches: ['main', 'feat/int'],
      build: 'refs/heads/feat/int',
      base: null,
      status: 'done',
      differsOn: ['main', 'feat/a'],
    })),
    ...[failed, { code: 0, out: 'refs/remotes/origin/main\n', truncated: true }].map(
      (originRef) => ({
        originRef,
        branches: ['main', 'feat/int'],
        build: null,
        base: null,
        status: null,
        defaultUnknown: true,
      }),
    ),
    {
      originRef: failed,
      branches: [],
      build: 'refs/heads/feat/a',
      base: null,
      status: 'claimed',
      differsOn: ['main', 'feat/int'],
      defaultUnknown: true,
    },
    {
      branch: undefined,
      originHead: undefined,
      heads: [],
      branches: [],
      build: 'HEAD',
      base: null,
      status: 'needs-info',
    },
    {
      currentRef: failed,
      originHead: undefined,
      heads: [],
      branches: [],
      build: null,
      base: null,
      status: null,
    },
    {
      branch: undefined,
      probes: { 'refs/heads/main': failed },
      branches: [],
      build: null,
      base: null,
      status: null,
    },
  ]
  for (const row of rows) {
    const world = {
      branch: 'feat/a',
      head: SHA,
      originHead: 'main',
      heads: ['main', 'feat/a', 'feat/int'],
      ...row,
    }
    const baseIo = repo(world)
    const io = {
      ...baseIo,
      git: async (args: string[], stdin?: string): Promise<GitResult> => {
        if (args[0] === 'for-each-ref') {
          const refs = world.heads.map((h) => `refs/heads/${h}`)
          return {
            code: 0,
            out:
              args[1] === '--format=%(refname)'
                ? refs.map((ref) => `${ref}\n`).join('')
                : refs
                    .filter((ref) => args.slice(2).includes(ref))
                    .map(
                      (ref) =>
                        `${ref === 'refs/heads/main' ? 300 : ref === 'refs/heads/feat/int' ? 200 : 100}\t${ref}\n`,
                    )
                    .join(''),
            truncated: false,
          }
        }
        if (args[0] === 'ls-tree') return { code: 0, out: `${path}\0`, truncated: false }
        if (args[0] === 'cat-file') {
          // The newer default branch has stale tickets; neither it nor an ambiguous tag may override build.
          const blobs = Object.fromEntries(
            Object.entries(tickets).map(([ref, text]) => [`${ref}:${path}`, text]),
          )
          return { code: 0, out: catFile(blobs)(stdin), truncated: false }
        }
        if (args[0] === 'log') return { code: 0, out: `\0${SHA}\tbuild\0`, truncated: false }
        if (args[0] === 'merge-base') return { code: 0, out: '', truncated: false }
        return baseIo.git(args, stdin)
      },
    }
    const facts = await repoFacts(io)
    if (facts === null) throw new Error('expected repository facts')
    expect([facts.branch, facts.defaultBranch, facts.defaultRef]).toEqual([
      world.branch === undefined ? null : (row.branchShort ?? world.branch),
      world.originHead === undefined ? null : (row.originShort?.replace(/^origin\//, '') ?? 'main'),
      row.base,
    ])
    const build = await buildBranch(io, { ...saved, branches: row.branches }, facts)
    const read = build === null ? null : await readTickets(io, '.scratch/f', facts, build)
    expect([build, read?.tickets.map((t) => [t.path, t.status, t.differsOn]) ?? null]).toEqual([
      row.build,
      row.status === null ? null : [[path, row.status, row.differsOn]],
    ])
    if (read !== null) {
      expect(read.othersUnknown).toBe(false)
      expect(read.unreadable).toEqual([])
    }
    expect(await mergedState(io, saved, facts)).toBe(
      row.defaultUnknown || world.originHead === undefined ? 'unknown' : 'n/a',
    )
    expect(await mergedState(io, { ...saved, tips: { 'feat/a': SHA } }, facts)).toBe(
      row.base === null ? 'unknown' : true,
    )
    expect(await branchCommits(io, facts)).toEqual(
      row.base === null ? null : [{ sha: SHA, subject: 'build', files: [] }],
    )
    const onMain = await repoFacts({
      ...io,
      git: async (args, stdin) =>
        args[0] === 'symbolic-ref' && args[args.length - 1] === 'HEAD'
          ? {
              code: 0,
              out: args.includes('--short') ? 'main\n' : 'refs/heads/main\n',
              truncated: false,
            }
          : io.git(args, stdin),
    })
    if (onMain === null) throw new Error('expected default checkout facts')
    expect(await branchCommits(io, onMain)).toBe(null)
  }
})

test('main-worktree discovery preserves unusual paths and unknown ticket inventories', async () => {
  const path = '.scratch/f/issues/02-new.md'
  const main = '/repos/my\tä\ncheckout'
  const listing = `worktree ${main}\0HEAD ${SHA}\0branch refs/heads/main\0\0worktree /r/wt\0HEAD ${SHA}\0branch refs/heads/feat/a\0\0`
  const read = async (worktrees: GitResult | string) => {
    const base = repo(
      { where: '/r/wt\n/r/.git\n', branch: 'feat/a', head: SHA, worktrees },
      { [`${main}/${path}`]: 'Status: needs-triage' },
    )
    const io = {
      ...base,
      git: async (args: string[], stdin?: string): Promise<GitResult> =>
        args[0] === 'ls-tree' ? { code: 0, out: '', truncated: false } : base.git(args, stdin),
    }
    const facts = await repoFacts(io)
    if (facts === null) throw new Error('expected linked-worktree facts')
    return readTickets(io, '.scratch/f', facts, 'refs/heads/feat/a')
  }
  expect((await read(listing))?.tickets.map((t) => [t.path, t.status])).toEqual([
    [path, 'needs-triage'],
  ])
  const none = { tickets: [], unreadable: [], othersUnknown: false }
  expect(await read('')).toEqual(none)
  expect(await read('worktree /r/.git\0bare\0\0')).toEqual(none)
  expect(await read({ code: 128, out: '', truncated: false })).toBe(null)
  expect(await read({ code: 0, out: listing, truncated: true })).toBe(null)
})

test('repoFacts is null when a checkout path holds a line break', async () => {
  // The checkout `/tmp/r<LF>other`: read line by line, its common dir would be the relative `other`.
  const where = '/tmp/r\nother\n/tmp/r\nother/.git\n'
  expect(await repoFacts(repo({ where, branch: 'main', head: SHA }))).toBe(null)
})

const SUMMARY = '/r/.git/whereami/branches/feat%2Fa'
const SPEC = '/r/docs/spec.md'
// feat/a's one commit adds a spec, so the session's refresh has a feature to write.
const SPEC_COMMIT = `\0${SHA}\tspec\0\ndocs/superpowers/specs/2026-10-05-demo-design.md\0`

// A session starting in /r on feat/a, on a case-insensitive disk holding `files`, `dirs` and `links` (each
// path to the one it leads to), each spelled as on disk and reached by any spelling. Answers what was
// written and logged.
async function startOn(
  $: Parameters<TestBody>[0],
  on: Parameters<TestBody>[1],
  disk: {
    files: string[]
    dirs: string[]
    links?: Record<string, string>
    // Files with their text; unstat: files there whose stat is denied.
    text?: Record<string, string>
    unstat?: string[]
    unread?: string[]
    unlist?: string[]
  },
  deny = (_path: string) => false,
) {
  const text = disk.text ?? {}
  const nodes = [
    ...disk.dirs.map((path) => ({ path, kind: 'dir' as const, to: undefined })),
    ...[...disk.files, ...Object.keys(text)].map((path) => ({
      path,
      kind: 'file' as const,
      to: undefined,
    })),
    ...Object.entries(disk.links ?? {}).map(([path, to]) => ({ path, kind: 'other' as const, to })),
  ]
  const find = (path: string) => nodes.find((n) => n.path.toLowerCase() === path.toLowerCase())
  // Where a path lands, links followed, and its own last node; null when it is not there.
  const walk = (path: string) => {
    let at = ''
    let node: (typeof nodes)[number] | undefined
    for (const part of path.split('/').slice(1)) {
      node = find(`${at}/${part}`)
      if (node === undefined) return null
      at = node.to ?? `${at}/${part}`
    }
    return node === undefined ? null : { at, node }
  }
  const real = (path: string) => walk(path)?.at ?? null
  const git = repo({ branch: 'feat/a', head: SHA, heads: ['main', 'feat/a'] })
  const written: string[] = []
  const wrote: Record<string, string> = {}
  const logged: string[] = []
  const clock = mock.clock(on, { now: 1791200000000 })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('process.run', async (_$, e) => {
    const r =
      e.argv[1] === 'log'
        ? { code: 0, out: SPEC_COMMIT, truncated: false }
        : await git.git(e.argv.slice(1))
    const value = { exitCode: r.code, stdout: r.out, stderr: '' }
    return { value: { ...value, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', (_$, e) => ({ value: real(posix(e.path)) !== null }))
  on('fs.stat', (_$, e) => {
    const path = posix(e.path)
    if (disk.unstat?.includes(path)) return { deny: 'EACCES' }
    const w = walk(path)
    const kind = w === null ? undefined : find(w.at)?.kind
    if (w === null || kind === undefined) return { deny: 'ENOENT' }
    const isLink = w.node.to !== undefined
    return {
      value: { kind, size: 0, mtimeMs: 0, isLink, ...(e.resolve ? { realPath: w.at } : {}) },
    }
  })
  on('fs.list', (_$, e) => {
    const path = posix(e.path)
    if (disk.unlist?.includes(path)) return { deny: 'EACCES' }
    const dir = real(path)?.toLowerCase()
    if (dir === undefined) return { deny: 'ENOENT' }
    const value = nodes
      .filter((n) => n.path.slice(0, n.path.lastIndexOf('/')).toLowerCase() === dir)
      .map((n) => ({
        name: n.path.slice(n.path.lastIndexOf('/') + 1),
        kind: n.kind,
        size: 0,
        mtimeMs: 0,
        isLink: n.to !== undefined,
      }))
    return { value }
  })
  on('fs.read', (_$, e) => {
    const path = posix(e.path)
    if (disk.unread?.includes(path)) return { deny: 'EACCES' }
    const at = real(path)
    const found = Object.entries(text).find(([p]) => real(p) === at)
    return found === undefined ? { deny: 'ENOENT' } : { value: found[1] }
  })
  on('fs.write', (_$, e) => {
    const path = posix(e.path)
    if (deny(path)) return { deny: 'read-only' }
    written.push(path)
    wrote[path] = e.text
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  const started = await $.session.start({ cwd: '/r', surface: null, isInteractive: false })
  expect(started).toEqual({ cwd: '/r' })
  // The start never awaits its refresh: let it finish.
  await clock.settle()
  return { written, wrote, logged: logged.join('\n') }
}

const REPO = ['/r', '/r/.git', '/r/docs']

test('a refused write leaves the old summary undated and logs why', async ($, on) => {
  // Over the last summary; writing `message` is refused.
  const files = [`${SUMMARY}/seen`, `${SUMMARY}/message`]
  const dirs = [...REPO, '/r/.git/whereami', '/r/.git/whereami/branches', SUMMARY]
  const { written, logged } = await startOn($, on, { files, dirs }, (p) => p.endsWith('/message'))
  expect(written.filter((p) => p.startsWith(SUMMARY))).toEqual([
    `${SUMMARY}/feature`,
    `${SUMMARY}/name`,
  ])
  expect(logged).toContain(`${SUMMARY}/message`)
})

test('a write never goes through a link that differs from its path only by case', async ($, on) => {
  // MESSAGE, a link to the spec, is the same file as `message` here: the writer stops there.
  const dirs = [...REPO, '/r/.git/whereami', '/r/.git/whereami/branches', SUMMARY]
  const links = { [`${SUMMARY}/MESSAGE`]: SPEC }
  const { written, logged } = await startOn($, on, { files: [SPEC], dirs, links })
  expect(written.filter((p) => p.startsWith(SUMMARY))).toEqual([
    `${SUMMARY}/feature`,
    `${SUMMARY}/name`,
  ])
  expect(logged).toContain(`${SUMMARY}/message: Error: not a plain file`)
})

test('a write never lands through a whereami folder linked by another case', async ($, on) => {
  // WHEREAMI links to /r/docs: every file would land beside the spec, so none is written.
  const links = { '/r/.git/WHEREAMI': '/r/docs' }
  const { written, logged } = await startOn($, on, { files: [SPEC], dirs: REPO, links })
  expect(written).toEqual([])
  expect(logged).toContain(
    '/r/.git/whereami/features/demo/note.json: Error: lands outside whereami/: /r/docs/features/demo',
  )
})

const DEMO_PLAN = 'docs/superpowers/plans/2026-10-05-demo.md'
const SDD = '/r/.superpowers/sdd/demo'
const FEATURE = '/r/.git/whereami/features/demo'
const PROGRESS = `${SDD}/progress.md`

// feat/a's demo build of one task, its ledger complete, as an earlier session left it: in review, the
// all-complete snapshot saved in the note. The disk for startOn.
async function reviewedBuild() {
  const world: Record<string, string> = {
    [`/r/${DEMO_PLAN}`]:
      '**Spec:** `docs/superpowers/specs/2026-10-05-demo-design.md`\n### Task 1: One\n',
    [`${SDD}/plan-path`]: `${DEMO_PLAN}\n`,
    [PROGRESS]: `# SDD ledger — plan: ${DEMO_PLAN}\nTask 1: complete (commits a..b, review clean)\n`,
  }
  const earlier = repo({ branch: 'feat/a', head: SHA, heads: ['main', 'feat/a'] }, { ...world })
  const log = { code: 0, out: SPEC_COMMIT, truncated: false }
  await refresh(
    { ...earlier, git: async (a) => (a[0] === 'log' ? log : earlier.git(a)) },
    {
      observed: [],
      skillDocs: [],
      writtenDocs: [],
      agentsRunning: 0,
      agentsBeforeClear: 0,
      installed: new Set(),
      since: Number.POSITIVE_INFINITY,
    },
  )
  const noteJson = earlier.written[`${FEATURE}/note.json`] ?? ''
  expect(JSON.parse(noteJson).last.allComplete).toBe(true)
  const dirs = [
    ...REPO,
    ...['/r/docs/superpowers', '/r/docs/superpowers/plans', '/r/.superpowers', SDD],
    ...['/r/.superpowers/sdd', '/r/.git/whereami', '/r/.git/whereami/features', FEATURE],
  ]
  const text: Record<string, string> = { ...world, [`${FEATURE}/note.json`]: noteJson }
  return { files: [], dirs, text }
}

test('a ledger still there whose stat is denied is unreadable: the snapshot stays, nothing finishes', async ($, on) => {
  const disk = { ...(await reviewedBuild()), unstat: [PROGRESS] }
  const { wrote } = await startOn($, on, disk)
  expect(wrote[`${FEATURE}/finished`]).toBe('')
  expect(JSON.parse(wrote[`${FEATURE}/note.json`] ?? '').last.allComplete).toBe(true)
})

for (const [operation, path] of [
  ['unstat', `${SDD}/plan-path`],
  ['unread', `${SDD}/plan-path`],
  ['unlist', '/r/.superpowers/sdd'],
] as const) {
  test(`ledger discovery ${operation} failure preserves the last seen build`, async ($, on) => {
    const disk = { ...(await reviewedBuild()), [operation]: [path] }
    const { wrote, logged } = await startOn($, on, disk)
    expect(wrote[`${FEATURE}/finished`]).toBeUndefined()
    expect(wrote[`${FEATURE}/note.json`]).toBeUndefined()
    expect(logged).toContain(path)
  })
}

test('a missing plan-path does not mean its saved progress file was removed', async ($, on) => {
  const disk = await reviewedBuild()
  delete disk.text[`${SDD}/plan-path`]
  const { wrote } = await startOn($, on, disk)
  expect(wrote[`${SUMMARY}/message`]).toContain('review')
  expect(wrote[`${FEATURE}/finished`]).toBe('')
  expect(JSON.parse(wrote[`${FEATURE}/note.json`] ?? '').last.allComplete).toBe(true)
})

test('a ledger confirmed deleted after a reviewed build finishes it from the snapshot', async ($, on) => {
  const disk = await reviewedBuild()
  delete disk.text[PROGRESS]
  delete disk.text[`${SDD}/plan-path`]
  disk.dirs = disk.dirs.filter((path) => !path.startsWith('/r/.superpowers/sdd'))
  const { wrote } = await startOn($, on, disk)
  expect(wrote[`${FEATURE}/finished`]).toMatch(/^\d+\n$/)
})
