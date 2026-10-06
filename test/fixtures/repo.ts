import type { GitResult } from '../../src/types'
import { THREE_TASK_PLAN } from './sp'

// A Superpowers build of `auth` on feat/auth in /r, shared by the refresh and wiring tests.
export const HEAD = 'c'.repeat(40)
export const PLAN = 'docs/superpowers/plans/2026-10-05-auth.md'
export const LEDGER = '/r/.superpowers/sdd/auth/progress.md'
export const NO: GitResult = { code: 1, out: '', truncated: false }

// The git state a test moves between refreshes. branch null: detached HEAD.
export type Repo = {
  branch: string | null
  log: string
  merged: boolean
  deleted: boolean
  since: string
}

export const repo = (fields: Partial<Repo> = {}): Repo => ({
  branch: 'feat/auth',
  log: '',
  merged: false,
  deleted: false,
  since: '',
  ...fields,
})

// git as repoFacts, gather and the readers ask it, answered from `r`; any other call fails (code 128).
export const git =
  (r: Repo) =>
  (args: string[]): GitResult | string | null => {
    const a = args.join(' ')
    if (a === 'rev-parse --path-format=absolute --show-toplevel --git-common-dir')
      return '/r\n/r/.git\n'
    if (a === 'rev-parse --path-format=absolute --show-toplevel') return '/r\n'
    if (a === 'symbolic-ref --quiet --short HEAD') return r.branch === null ? NO : `${r.branch}\n`
    if (a === 'symbolic-ref --quiet HEAD')
      return r.branch === null ? NO : `refs/heads/${r.branch}\n`
    if (a === 'rev-parse --verify --quiet HEAD') return `${HEAD}\n`
    if (a.startsWith('symbolic-ref') && a.endsWith('refs/remotes/origin/HEAD')) return NO
    if (a === 'show-ref --verify --quiet refs/heads/main') return ''
    if (a.startsWith('show-ref --verify --quiet refs/heads/')) return r.deleted ? NO : ''
    if (a === 'worktree list --porcelain -z')
      return 'worktree /r\0HEAD x\0branch refs/heads/main\0\0'
    if (a.startsWith('log --name-only')) return r.log
    if (a.startsWith('log --format=%H')) return r.since
    if (args[0] === 'for-each-ref')
      return r.deleted
        ? ''
        : args
            .slice(2)
            .map((ref) => `1\t${ref}\n`)
            .join('')
    if (args[0] === 'ls-tree') return ''
    if (a.startsWith('merge-base --is-ancestor')) return r.merged ? '' : NO
    return null
  }

export const ledger = (...lines: string[]) => [`# SDD ledger — plan: ${PLAN}`, ...lines].join('\n')
export const complete = (n: number) => `Task ${n}: complete (commits a..b, review clean)`

// A Superpowers build of `auth` on feat/auth: the plan, its ledger folder and the ledger.
export const spWorld = (...lines: string[]): Record<string, string> => ({
  [`/r/${PLAN}`]: THREE_TASK_PLAN,
  '/r/.superpowers/sdd/auth/plan-path': `${PLAN}\n`,
  [LEDGER]: ledger(...lines),
})
