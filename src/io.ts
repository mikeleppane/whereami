import type { GitResult, ReadOutcome, RepoFacts } from './types'

// Everything whereami asks of the world: makeIo in hooks/register.tsx (the engine follows $ into no
// imported function), test/fake-io.ts in tests.
export type Io = {
  git(args: string[], stdin?: string): Promise<GitResult>
  read(path: string): Promise<ReadOutcome>
  write(path: string, text: string): Promise<boolean>
  list(dir: string): Promise<string[]>
  mtimeMs(path: string): Promise<number | null>
  now(): Promise<number>
}

// Output lines, or null when git failed or its output was cut.
async function gitLines(io: Io, args: string[]): Promise<string[] | null> {
  const r = await io.git(args)
  return r.code === 0 && !r.truncated ? r.out.split(/\r?\n/) : null
}

const first = async (io: Io, args: string[]) => (await gitLines(io, args))?.[0] || null
const hasBranch = async (io: Io, b: string) =>
  (await io.git(['show-ref', '--verify', '--quiet', `refs/heads/${b}`])).code === 0

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
  const where = r.code === 0 && !r.truncated ? TWO_PATHS.exec(r.out) : null
  const root = where?.[1]
  const commonDir = where?.[2]
  if (!root || !commonDir) return null
  const branch = await first(io, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const head = await first(io, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  const originHead = await first(io, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ])
  const defaultBranch =
    originHead?.replace(/^origin\//, '') ??
    ((await hasBranch(io, 'main')) ? 'main' : (await hasBranch(io, 'master')) ? 'master' : null)
  // The first worktree entry is the main checkout, or the repo itself when it is bare.
  const list = await gitLines(io, ['worktree', 'list', '--porcelain'])
  const end = list?.indexOf('') ?? -1
  const block = (end < 0 ? list : list?.slice(0, end)) ?? []
  const mainRoot =
    block[0]?.startsWith('worktree ') && !block.includes('bare') ? block[0].slice(9) : null
  return { root, commonDir, mainRoot, branch, head, defaultBranch }
}
