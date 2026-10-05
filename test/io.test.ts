import { expect, mock, type TestBody, test } from 'claude-code/testing'
import { repoFacts } from '../src/io'
import { fakeIo } from './fake-io'

type World = {
  where?: string
  branch?: string
  head?: string
  originHead?: string
  heads?: string[]
}

// git as a repo at /r answers: the commands repoFacts runs, keyed by their arguments.
const repo = (w: World) =>
  fakeIo({}, (args) => {
    const heads = w.heads ?? ['main']
    const answers: Record<string, string | null> = {
      'rev-parse --path-format=absolute --show-toplevel --git-common-dir':
        w.where ?? '/r\n/r/.git\n',
      'symbolic-ref --quiet --short HEAD': w.branch === undefined ? null : `${w.branch}\n`,
      'rev-parse --verify --quiet HEAD': w.head === undefined ? null : `${w.head}\n`,
      'symbolic-ref --quiet --short refs/remotes/origin/HEAD':
        w.originHead === undefined ? null : `origin/${w.originHead}\n`,
      'worktree list --porcelain': `worktree /r\nHEAD ${w.head ?? '0'.repeat(40)}\nbranch refs/heads/main\n\nworktree /r/wt\ndetached\n\n`,
    }
    for (const h of heads) answers[`show-ref --verify --quiet refs/heads/${h}`] = ''
    return answers[args.join(' ')] ?? null
  })

const SHA = 'a'.repeat(40)

test('repoFacts on a branch', async () => {
  expect(await repoFacts(repo({ branch: 'feat/a', head: SHA, originHead: 'trunk' }))).toEqual({
    root: '/r',
    commonDir: '/r/.git',
    mainRoot: '/r',
    branch: 'feat/a',
    head: SHA,
    defaultBranch: 'trunk',
  })
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

test('repoFacts falls back to master without origin/HEAD or main', async () => {
  const facts = await repoFacts(repo({ branch: 'x', head: SHA, heads: ['master', 'x'] }))
  expect(facts?.defaultBranch).toBe('master')
})

test('repoFacts outside a repo is null', async () => {
  expect(await repoFacts(fakeIo({}, () => null))).toBe(null)
})

test('repoFacts is null when a checkout path holds a line break', async () => {
  // The checkout `/tmp/r<LF>other`: read line by line, its common dir would be the relative `other`.
  const where = '/tmp/r\nother\n/tmp/r\nother/.git\n'
  expect(await repoFacts(repo({ where, branch: 'main', head: SHA }))).toBe(null)
})

const SUMMARY = '/r/.git/whereami/branches/main'
const SPEC = '/r/docs/spec.md'

// A session starting in /r on main, on a case-insensitive disk holding `files`, `dirs` and `links` (each
// path to the one it leads to), each spelled as on disk and reached by any spelling. Answers what was
// written and logged.
async function startOn(
  $: Parameters<TestBody>[0],
  on: Parameters<TestBody>[1],
  disk: { files: string[]; dirs: string[]; links?: Record<string, string> },
  deny = (_path: string) => false,
) {
  const nodes = [
    ...disk.dirs.map((path) => ({ path, kind: 'dir' as const, to: undefined })),
    ...disk.files.map((path) => ({ path, kind: 'file' as const, to: undefined })),
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
  const git = repo({ branch: 'main', head: SHA })
  const written: string[] = []
  const logged: string[] = []
  mock.clock(on, { now: 1791200000000 })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('process.run', async (_$, e) => {
    const r = await git.git(e.argv.slice(1))
    const value = { exitCode: r.code, stdout: r.out, stderr: '' }
    return { value: { ...value, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', (_$, e) => ({ value: real(e.path) !== null }))
  on('fs.stat', (_$, e) => {
    const w = walk(e.path)
    const kind = w === null ? undefined : find(w.at)?.kind
    if (w === null || kind === undefined) return { deny: 'ENOENT' }
    const isLink = w.node.to !== undefined
    return {
      value: { kind, size: 0, mtimeMs: 0, isLink, ...(e.resolve ? { realPath: w.at } : {}) },
    }
  })
  on('fs.list', (_$, e) => {
    const dir = real(e.path)?.toLowerCase()
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
  on('fs.write', (_$, e) => {
    if (deny(e.path)) return { deny: 'read-only' }
    written.push(e.path)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  const started = await $.session.start({ cwd: '/r', surface: null, isInteractive: false })
  expect(started).toEqual({ cwd: '/r' })
  return { written, logged: logged.join('\n') }
}

const REPO = ['/r', '/r/.git', '/r/docs']

test('a refused write leaves the old summary undated and logs why', async ($, on) => {
  // Over the last summary; writing `message` is refused.
  const files = [`${SUMMARY}/seen`, `${SUMMARY}/message`]
  const dirs = [...REPO, '/r/.git/whereami', '/r/.git/whereami/branches', SUMMARY]
  const { written, logged } = await startOn($, on, { files, dirs }, (p) => p.endsWith('/message'))
  expect(written).toEqual([`${SUMMARY}/feature`, `${SUMMARY}/name`])
  expect(logged).toContain(`${SUMMARY}/message`)
})

test('a write never goes through a link that differs from its path only by case', async ($, on) => {
  // MESSAGE, a link to the spec, is the same file as `message` here: the writer stops there.
  const dirs = [...REPO, '/r/.git/whereami', '/r/.git/whereami/branches', SUMMARY]
  const links = { [`${SUMMARY}/MESSAGE`]: SPEC }
  const { written, logged } = await startOn($, on, { files: [SPEC], dirs, links })
  expect(written).toEqual([`${SUMMARY}/feature`, `${SUMMARY}/name`])
  expect(logged).toContain(`${SUMMARY}/message: Error: not a plain file`)
})

test('a write never lands through a whereami folder linked by another case', async ($, on) => {
  // WHEREAMI links to /r/docs: every summary file would land beside the spec, so none is written.
  const links = { '/r/.git/WHEREAMI': '/r/docs' }
  const { written, logged } = await startOn($, on, { files: [SPEC], dirs: REPO, links })
  expect(written).toEqual([])
  expect(logged).toContain(
    `${SUMMARY}/feature: Error: lands outside whereami/: /r/docs/branches/main`,
  )
})
