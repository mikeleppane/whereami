import type { NoteRef } from './feature'
import { answered, gitLines, gitOut, hasBranch, hasRef, type Io, parseCatFileBatch } from './io'
import { parseTicket, type Ticket } from './matt'
import { parseNote } from './notes'
import type { Note, RepoFacts } from './types'

export type Commit = { sha: string; subject: string; files: string[] }

// A commit id from a note: only hex reaches git's arguments, so a stored value never reads as an option.
const HEX = /^[0-9a-fA-F]+$/

// The branch's own commits, or null where there are none to tell (no default branch, on it, git failed or cut).
export async function branchCommits(io: Io, facts: RepoFacts): Promise<Commit[] | null> {
  const base = facts.defaultRef
  if (base === null || facts.branchRef === `refs/heads/${facts.defaultName}`) return null
  const out = await gitOut(io, [
    'log',
    '--name-only',
    '-z',
    '--format=%x00%H%x09%s',
    '--end-of-options',
    `${base}..HEAD`,
  ])
  if (out === null) return null
  // -z, names as they are: `\0<sha>\t<subject>\0`, then `\n` and each file name ending in `\0`. An empty token
  // (never a name) comes before every header.
  const commits: Commit[] = []
  let header = false
  for (const token of out.split('\0')) {
    const last = commits[commits.length - 1]
    if (token === '') header = true
    else if (header) {
      const tab = token.indexOf('\t')
      commits.push({ sha: token.slice(0, tab), subject: token.slice(tab + 1), files: [] })
      header = false
    } else last?.files.push(last.files.length === 0 ? token.replace(/^\n/, '') : token)
  }
  return commits
}

export function taskNumbers(commits: Commit[]): number[] {
  const named = commits.flatMap((c) =>
    [...c.subject.matchAll(/\bTask (\d+)\b/gi)].map((m) => Number(m[1])),
  )
  return [...new Set(named)].sort((a, b) => a - b)
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Keys of tickets a subject names by number (`01`, `#01`) or slug, each as a whole word in any script.
export function relatedKeys(commits: Commit[], tickets: Ticket[]): string[] {
  const keys = tickets
    .filter((t) => t.key !== '')
    .filter((t) => {
      const words = [t.key, t.slug].filter((w) => w !== '').map(literal)
      const named = new RegExp(
        `(?:^|[^\\p{L}\\p{M}\\p{N}_])(?:${words.join('|')})(?![\\p{L}\\p{M}\\p{N}_])`,
        'iu',
      )
      return commits.some((c) => named.test(c.subject))
    })
    .map((t) => t.key)
  return [...new Set(keys)]
}

// Commits since an observed HEAD, or every commit when it was observed before the first one. null: unknown
// (a head that is no commit id, git failed or its output was cut), never a count of 0.
export async function commitsSince(io: Io, head: string | null): Promise<number | null> {
  if (head !== null && !HEX.test(head)) return null
  const lines = await gitLines(io, ['log', '--format=%H', head === null ? 'HEAD' : `${head}..HEAD`])
  return lines === null ? null : lines.filter((l) => l !== '').length
}

// Ledger folders and the plan each names; the old flat `.superpowers/sdd/progress.md` has no plan-path.
export async function ledgerDirs(io: Io, root: string): Promise<{ dir: string; plan: string }[]> {
  const sdd = `${root}/.superpowers/sdd`
  const found: { dir: string; plan: string }[] = []
  for (const name of await io.list(sdd)) {
    const dir = `${sdd}/${name}`
    const r = await io.read(`${dir}/plan-path`)
    const plan = r.ok ? r.text.split(/\r?\n/)[0]?.trim() : undefined
    if (plan) found.push({ dir, plan })
  }
  return found
}

// root: <common dir>/whereami. invalid: folder names whose note.json is there but not a note.
// finished: note id to the epoch seconds in its `finished` file.
export async function readNotes(
  io: Io,
  root: string,
): Promise<{ notes: Note[]; invalid: string[]; finished: Record<string, number> }> {
  const notes: Note[] = []
  const invalid: string[] = []
  // No prototype: an id like `constructor` or `__proto__` is an entry of its own, or none.
  const finished: Record<string, number> = Object.create(null)
  for (const name of await io.list(`${root}/features`)) {
    const dir = `${root}/features/${name}`
    if ((await io.mtimeMs(`${dir}/forget`)) !== null) continue
    const r = await io.read(`${dir}/note.json`)
    if (!r.ok && r.why === 'missing') continue
    const note = r.ok ? parseNote(r.text) : null
    if (note === null) {
      invalid.push(name)
      continue
    }
    notes.push(note)
    const at = await io.read(`${dir}/finished`)
    if (at.ok && /^\d+$/.test(at.text.trim())) finished[note.id] = Number(at.text.trim())
  }
  return { notes, invalid, finished }
}

export async function noteRefs(
  io: Io,
  repoRoot: string,
  notes: Note[],
  finished: Record<string, number>,
): Promise<NoteRef[]> {
  const refs: NoteRef[] = []
  for (const note of notes) {
    let lastChange = 0
    for (const doc of Object.values(note.docs)) {
      if (doc === undefined) continue
      const at = await io.mtimeMs(`${repoRoot}/${doc.replace(/\/$/, '')}`)
      lastChange = Math.max(lastChange, at ?? 0)
    }
    const { id, branches, unlinked, docs } = note
    refs.push({ id, branches, unlinked, docs, lastChange, finished: Object.hasOwn(finished, id) })
  }
  return refs
}

// The note's own branch with the newest tip (the integration branch once implement-spec commits there), else
// the current branch, else the default branch; HEAD only when both are confirmed absent. Returned as a full ref.
// null: selection needs branch identity, ref discovery or enumeration that git could not answer. Task 14 must
// preserve this as unknown ticket evidence, not fall back to a display name, HEAD, or an empty inventory.
export async function buildBranch(io: Io, note: Note, facts: RepoFacts): Promise<string | null> {
  if (note.branches.length > 0 && facts.defaultName === undefined) return null
  const own = note.branches.filter((b) => b !== facts.defaultName).map((b) => `refs/heads/${b}`)
  // A pattern matches every branch below it too (`refs/heads/feat` takes `feat/a`): only the note's own count.
  const lines =
    own.length === 0
      ? []
      : await gitLines(io, ['for-each-ref', '--format=%(committerdate:unix)%09%(refname)', ...own])
  if (lines === null) return null
  let best: string | null = null
  let bestAt = -1
  for (const line of lines) {
    const tab = line.indexOf('\t')
    const at = Number(line.slice(0, tab))
    const name = line.slice(tab + 1)
    if (tab > 0 && own.includes(name) && at > bestAt) {
      best = name
      bestAt = at
    }
  }
  if (best !== null) return best
  if (facts.branchRef === undefined) return null
  return facts.branchRef ?? facts.defaultRef ?? (facts.defaultName === null ? 'HEAD' : null)
}

// Spec section 5, "Where tickets are read". folder: repo-relative `.scratch/<f>`; build: buildBranch's ref. A
// ticket committed on `build` is read from there, any other from the working tree (the current one, else the main
// one when the current has no tickets). differsOn: other branches whose copy parses to another status; it never
// overrides. unreadable: a ticket that could not be read; with `branch`, only that branch's copy could not be read
// (so differsOn cannot speak for it); a copy missing there is no entry. null: git could not tell which tickets are
// committed or what they hold (it failed or was cut), or the required main-worktree fallback is unknown.
// Task 14 must keep that null as unknown evidence and suppress ticket creation, not pass [] to readMatt.
export async function readTickets(
  io: Io,
  folder: string,
  facts: RepoFacts,
  build: string,
  otherBranches: string[],
): Promise<{
  tickets: (Ticket & { differsOn?: string[] })[]
  unreadable: { path: string; why: string; branch?: string }[]
} | null> {
  const issues = `${folder}/issues`
  const md = (names: string[]) => names.filter((n) => n.endsWith('.md'))
  // -z: names as they are, not C-quoted when they hold non-ASCII bytes. A folder not committed lists nothing
  // with exit 0; a build branch git says is not there (before the first commit) has nothing committed; any other
  // failure is no answer.
  const tree = await gitOut(io, [
    'ls-tree',
    '-z',
    '--name-only',
    '--full-tree',
    '--end-of-options',
    build,
    '--',
    `${issues}/`,
  ])
  if (tree === null && (await hasRef(io, build)) !== false) return null
  const committed = md((tree ?? '').split('\0').map((p) => p.slice(issues.length + 1)))
  let dir = `${facts.root}/${issues}`
  let local = md(await io.list(dir))
  if (local.length === 0 && facts.mainRoot === undefined) return null
  if (local.length === 0 && facts.mainRoot !== null && facts.mainRoot !== facts.root) {
    dir = `${facts.mainRoot}/${issues}`
    local = md(await io.list(dir))
  }
  const names = [...new Set([...committed, ...local])].sort()
  const others = otherBranches.filter((b) => `refs/heads/${b}` !== build)
  // cat-file reads one spec per line: a spec holding a line break (in the folder or the name) cannot be asked,
  // so that copy is unreadable rather than splitting its line and shifting every later answer.
  const LINE_BREAK = /[\r\n]/
  const specs = [
    ...committed.map((n) => `${build}:${issues}/${n}`),
    ...others.flatMap((b) => names.map((n) => `refs/heads/${b}:${issues}/${n}`)),
  ].filter((spec) => !LINE_BREAK.test(spec))
  const out =
    specs.length === 0 ? '' : await gitOut(io, ['cat-file', '--batch'], `${specs.join('\n')}\n`)
  if (out === null) return null
  const blobs = parseCatFileBatch(out, specs)
  const blob = (spec: string): { ok: true; text: string } | { ok: false; why: string } =>
    LINE_BREAK.test(spec)
      ? { ok: false, why: 'line break in name' }
      : (blobs.get(spec) ?? { ok: false, why: 'error' })

  const tickets: (Ticket & { differsOn?: string[] })[] = []
  const unreadable: { path: string; why: string; branch?: string }[] = []
  for (const name of names) {
    const path = `${issues}/${name}`
    const text = committed.includes(name)
      ? blob(`${build}:${path}`)
      : await io.read(`${dir}/${name}`)
    if (!text.ok) unreadable.push({ path, why: text.why })
    const ticket = text.ok ? parseTicket(path, text.text) : null
    const differsOn: string[] = []
    for (const b of others) {
      const copy = blob(`refs/heads/${b}:${path}`)
      if (copy.ok) {
        if (ticket !== null && parseTicket(path, copy.text).status !== ticket.status)
          differsOn.push(b)
      } else if (copy.why !== 'missing') unreadable.push({ path, why: copy.why, branch: b })
    }
    if (ticket !== null) tickets.push(differsOn.length === 0 ? ticket : { ...ticket, differsOn })
  }
  return { tickets, unreadable }
}

// Spec section 5, `merged`: a stored tip of the feature's own branches is an ancestor of the default branch.
// Not an ancestor proves "not merged" only while the branch is there: a squash merge leaves no trace.
export async function mergedState(
  io: Io,
  note: Note,
  facts: RepoFacts,
): Promise<boolean | 'unknown' | 'n/a'> {
  const base = facts.defaultRef
  // Work on the default branch itself has no merged state.
  const tips = Object.entries(note.tips).filter(([b]) => b !== facts.defaultName)
  if (tips.length === 0) return 'n/a'
  if (base === null) return 'unknown'
  let state: false | 'unknown' = false
  for (const [branch, tip] of tips) {
    const ancestor = HEX.test(tip)
      ? answered(
          await io.git(['merge-base', '--is-ancestor', '--end-of-options', tip, base]),
          [0, 1],
        )
      : null
    if (ancestor?.code === 0) return true
    if (ancestor === null || (await hasBranch(io, branch)) !== true) state = 'unknown'
  }
  return state
}
