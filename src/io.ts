import type { GitResult, ReadOutcome, RepoFacts } from './types'

// Everything whereami asks of the world: makeIo in hooks/register.tsx (the engine follows $ into no
// imported function), test/fake-io.ts in tests.
export type Io = {
  git(args: string[], stdin?: string): Promise<GitResult>
  read(path: string): Promise<ReadOutcome>
  write(path: string, text: string): Promise<boolean>
  // Missing directories list nothing; other failures reject rather than inventing an empty inventory.
  list(dir: string): Promise<string[]>
  mtimeMs(path: string): Promise<number | null>
  now(): Promise<number>
}

export const MAX_READ = 1048576

// The one evidence rule: a git result is an answer only when its output is whole and it exited with one of
// `codes` (what each means is the caller's); anything else is unknown, and reads null.
export const answered = (r: GitResult, codes: number[] = [0]) =>
  !r.truncated && codes.includes(r.code) ? r : null

export async function gitOut(io: Io, args: string[], stdin?: string): Promise<string | null> {
  return answered(await io.git(args, stdin))?.out ?? null
}

export const gitLines = async (io: Io, args: string[]) =>
  (await gitOut(io, args))?.split(/\r?\n/) ?? null

const first = async (io: Io, args: string[]) => (await gitLines(io, args))?.[0] || null
// A full ref: true when it exists, false when git says it does not (exit 1), null when git cannot tell.
export async function hasRef(io: Io, ref: string): Promise<boolean | null> {
  const r = answered(await io.git(['show-ref', '--verify', '--quiet', ref]), [0, 1])
  return r === null ? null : r.code === 0
}
export const hasBranch = (io: Io, b: string) => hasRef(io, `refs/heads/${b}`)

const ORIGIN = 'refs/remotes/origin/'

// The default branch as a full ref for revisions: origin/HEAD's full target (never git's shortened name, which
// reads `remotes/origin/<b>` beside a local `origin/<b>`), else main, else master; the local branch before
// origin's. Keep its identity even when a later probe cannot resolve the revision ref.
async function defaultOf(io: Io): Promise<Pick<RepoFacts, 'defaultName' | 'defaultRef'>> {
  const unknown = { defaultName: undefined, defaultRef: null }
  const origin = answered(
    await io.git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']),
    [0, 1],
  )
  if (origin === null) return unknown
  if (origin.code === 0) {
    const target = origin.out.replace(/\r?\n$/, '')
    if (!target.startsWith(ORIGIN) || target.length === ORIGIN.length) return unknown
    const b = target.slice(ORIGIN.length)
    const local = await hasBranch(io, b)
    const defaultRef =
      local === true
        ? `refs/heads/${b}`
        : local === false && (await hasRef(io, target)) === true
          ? target
          : null
    return { defaultName: b, defaultRef }
  }
  for (const b of ['main', 'master']) {
    const local = await hasBranch(io, b)
    if (local === null) return unknown
    if (local) return { defaultName: b, defaultRef: `refs/heads/${b}` }
  }
  return { defaultName: null, defaultRef: null }
}

// Exactly two absolute paths, one per line: a path holding a line break cannot be told apart, so it is no repo.
const TWO_PATHS = /^((?:\/|[A-Za-z]:\/)[^\r\n]*)\r?\n((?:\/|[A-Za-z]:\/)[^\r\n]*)\r?\n$/

// The same git calls as hooks/session-start.sh, so the mod and the hook pick the same branch key.
export async function repoFacts(io: Io): Promise<RepoFacts | null> {
  const r = await io.git([
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
    '--git-common-dir',
  ])
  const where = answered(r) === null ? null : TWO_PATHS.exec(r.out)
  const root = where?.[1]
  const commonDir = where?.[2]
  if (!root || !commonDir) return null
  const branch = await first(io, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const current = answered(await io.git(['symbolic-ref', '--quiet', 'HEAD']), [0, 1])
  const branchRef = current?.code === 1 ? null : current?.out.replace(/\r?\n$/, '') || undefined
  const head = await first(io, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  const originHead = await first(io, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ])
  // The hook's name for it, from the same shortened output and the same fall-through on any failed probe.
  const defaultBranch =
    originHead?.replace(/^origin\//, '') ??
    ((await hasBranch(io, 'main')) === true
      ? 'main'
      : (await hasBranch(io, 'master')) === true
        ? 'master'
        : null)
  // Revisions name it by its full ref: never a same-named tag, never a leading `-`.
  const { defaultName, defaultRef } = await defaultOf(io)
  // The first worktree entry is the main checkout, or the repo itself when it is bare.
  const list = await gitOut(io, ['worktree', 'list', '--porcelain', '-z'])
  let mainRoot: RepoFacts['mainRoot']
  if (list === '') mainRoot = null
  else if (list !== null) {
    const end = list.indexOf('\0\0')
    const block = list.slice(0, end).split('\0')
    if (end >= 0 && block[0]?.startsWith('worktree '))
      mainRoot = block.includes('bare') ? null : block[0].slice(9)
  }
  return {
    root,
    commonDir,
    mainRoot,
    branch,
    branchRef,
    head,
    defaultBranch,
    defaultName,
    defaultRef,
  }
}

// `git cat-file --batch` output for specs, in their order: `<sha> <type> <size>`, then size bytes and `\n`, or
// `<spec> missing`. Sizes count bytes, so the walk is over UTF-8. Where the output ends early (cut at 4 MiB) or
// stops making sense, that spec and every later one read `error`.
export function parseCatFileBatch(out: string, specs: string[]): Map<string, ReadOutcome> {
  const bytes = new TextEncoder().encode(out)
  const utf8 = new TextDecoder()
  const read = new Map<string, ReadOutcome>()
  let at = 0
  for (const spec of specs) {
    const end = bytes.indexOf(10, at)
    if (end < 0) break
    const header = utf8.decode(bytes.subarray(at, end))
    at = end + 1
    if (header === `${spec} missing`) {
      read.set(spec, { ok: false, why: 'missing' })
      continue
    }
    const found = /^[0-9a-f]+ (\S+) (\d+)$/.exec(header)
    const size = Number(found?.[2])
    if (!found || bytes[at + size] !== 10) break
    const body = bytes.subarray(at, at + size)
    at += size + 1
    read.set(
      spec,
      found[1] !== 'blob'
        ? { ok: false, why: 'error' }
        : size > MAX_READ
          ? { ok: false, why: 'too-big' }
          : body.includes(0)
            ? { ok: false, why: 'not-text' }
            : { ok: true, text: utf8.decode(body) },
    )
  }
  for (const spec of specs) if (!read.has(spec)) read.set(spec, { ok: false, why: 'error' })
  return read
}
