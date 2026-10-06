import type { ForgetMarker } from './notes'
import { repoRelative } from './superpowers'
import type { Docs } from './types'

export type DocKind = 'sp-spec' | 'sp-plan' | 'matt-spec' | 'matt-map' | 'matt-ticket'

// path: repo-relative; folder: `.scratch/<f>` for Matt documents
export type DocRef = { kind: DocKind; path: string; folder?: string }

export type NoteRef = {
  id: string
  branches: string[]
  unlinked: string[]
  docs: Docs
  planSpec?: string
  lastChange: number
  finished: boolean
}

export type Why = 'ledger' | 'skill' | 'read' | 'linked' | 'written' | 'commits'

export const WHY_TEXT: Record<Why, string> = {
  ledger: 'progress file names its plan',
  skill: 'skill started with its document',
  read: 'document read after a skill started',
  linked: 'branch already linked',
  written: 'document written this session',
  commits: 'commits touch its documents',
}

// lastChange: epoch ms its documents last changed; 0 when unknown, and the view shows no date
export type Candidate = {
  id: string
  why: Why[]
  lastChange: number
  finished: boolean
  create?: DocRef
}

// planSpecs: plan path to its `**Spec:**` path, read before identity
// docTimes: repo-relative document path to its change time in epoch ms; a missing path is unknown
// chosen: the feature the user picked in the view; it wins while it is still a candidate
export type IdentityInput = {
  branch: string | null
  isDefault: boolean
  notes: NoteRef[]
  ledgerPlans: DocRef[]
  skillDocs: DocRef[]
  readDoc?: DocRef
  writtenDocs: DocRef[]
  commitDocs: DocRef[]
  planSpecs: Record<string, string>
  docTimes: Record<string, number>
  chosen?: string
  forgotten?: (ForgetMarker | null)[]
}

export type Identity =
  | { kind: 'one'; id: string; weak: boolean; create?: DocRef; switchedFrom?: string }
  | { kind: 'choose'; candidates: Candidate[] }
  | { kind: 'none' }

function classifyRelative(path: string): DocRef | null {
  if (/^docs\/superpowers\/specs\/[^/]+\.md$/.test(path)) return { kind: 'sp-spec', path }
  if (/^docs\/superpowers\/plans\/[^/]+\.md$/.test(path)) return { kind: 'sp-plan', path }
  const matt = /^(\.scratch\/[^/]+)\/(spec\.md|map\.md|issues\/[^/]+\.md)$/.exec(path)
  if (!matt) return null
  const [, folder, rest] = matt
  const kind = rest === 'spec.md' ? 'matt-spec' : rest === 'map.md' ? 'matt-map' : 'matt-ticket'
  return { kind, path, folder }
}

// Resolve event paths before the session can move to another directory. No filesystem access.
export function absolutePath(path: string, cwd: string): string {
  const slash = path.replace(/\\/g, '/')
  const full = /^(?:\/|[A-Za-z]:\/)/.test(slash) ? slash : `${cwd.replace(/\\/g, '/')}/${slash}`
  const root = /^(?:\/|[A-Za-z]:\/)/.exec(full)?.[0] ?? ''
  const parts: string[] = []
  for (const part of full.slice(root.length).split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '' && part !== '.') parts.push(part)
  }
  return root + parts.join('/')
}

export function classifyDoc(path: string, repoRoot: string, cwd?: string): DocRef | null {
  return classifyRelative(
    repoRelative(cwd === undefined ? path : absolutePath(path, cwd), repoRoot),
  )
}

function featureIdFor(doc: DocRef): string {
  if (doc.folder !== undefined) return doc.folder.slice('.scratch/'.length)
  const name = doc.path.slice(doc.path.lastIndexOf('/') + 1, -'.md'.length)
  return name.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/-design$/, '')
}

function uniqueId(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base
  let n = 2
  while (taken.includes(`${base}-${n}`)) n++
  return `${base}-${n}`
}

export function docFromArgs(
  skill: string,
  args: string,
  repoRoot: string,
  cwd?: string,
): DocRef | null {
  if (!skill.startsWith('superpowers:') && !skill.startsWith('mattpocock-skills:')) return null
  // An unterminated quote fails closed: its contents never become a document.
  if (!/^(?:"[^"]*"|'[^']*'|[^"'])*$/.test(args)) return null
  // A token runs to the next whitespace outside quotes; its quotes are stripped.
  for (const [token] of args.matchAll(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g)) {
    const doc = classifyDoc(token.replace(/"([^"]*)"|'([^']*)'/g, '$1$2'), repoRoot, cwd)
    if (doc) return doc
  }
  return null
}

function ownerOfPath(notes: NoteRef[], path: string, folder?: string): string | null {
  const holds = (docPath: string | undefined) =>
    docPath === path || (folder !== undefined && docPath?.startsWith(`${folder}/`) === true)
  return notes.find((note) => Object.values(note.docs).some(holds))?.id ?? null
}

export function ownerOf(
  notes: NoteRef[],
  doc: DocRef,
  planSpecs: Record<string, string>,
): string | null {
  const owner = ownerOfPath(notes, doc.path, doc.folder)
  const spec = doc.kind === 'sp-plan' ? planSpecs[doc.path] : undefined
  if (owner !== null || spec === undefined) return owner
  return ownerOfPath(notes, spec, classifyRelative(spec)?.folder)
}

const mattFolder = (path: string) => /^(\.scratch\/[^/]+\/)/.exec(path)?.[1]
const containsDocument = (documents: Set<string>, path: string) =>
  documents.has(path) || documents.has(mattFolder(path) ?? '')

// Plan/spec links run both ways; every Matt document belongs to its folder, including future tickets.
export function documentGroup(paths: string[], planSpecs: Record<string, string>): Set<string> {
  const documents = new Set<string>()
  const add = (path: string) => {
    documents.add(path)
    const folder = mattFolder(path)
    if (folder !== undefined) documents.add(folder)
  }
  for (const path of paths) add(path)
  let size: number
  do {
    size = documents.size
    for (const [plan, spec] of Object.entries(planSpecs))
      if (containsDocument(documents, plan) || containsDocument(documents, spec)) {
        add(plan)
        add(spec)
      }
  } while (size !== documents.size)
  return documents
}

function forgottenDocuments(input: IdentityInput): Set<string> {
  return documentGroup(
    (input.forgotten ?? []).flatMap((marker) => marker?.documents ?? []),
    input.planSpecs,
  )
}

// Each evidence document with the feature it joins: the note owning it, else the new feature of its group.
function memberships(input: IdentityInput): Map<DocRef, string> {
  const { notes } = input
  const forgotten = forgottenDocuments(input)
  const unknown = input.forgotten?.includes(null) === true
  const specOf = (doc: DocRef) => {
    const path = doc.kind === 'sp-plan' ? input.planSpecs[doc.path] : undefined
    return path === undefined ? null : classifyRelative(path)
  }
  // New documents sharing a base id, or linked by a plan's `**Spec:**` line, form one group named by its
  // root: a plan's spec comes before the plan, so which evidence reaches a refresh first never renames it.
  const parent = new Map<string, string>()
  const group = (key: string): string => {
    const up = parent.get(key)
    return up === undefined || up === key ? key : group(up)
  }
  const evidence = [
    ...input.ledgerPlans,
    ...input.skillDocs,
    ...(input.readDoc ? [input.readDoc] : []),
    ...input.writtenDocs,
    ...input.commitDocs,
  ].filter(
    (doc) =>
      !containsDocument(forgotten, doc.path) &&
      !(unknown && ownerOf(notes, doc, input.planSpecs) === null),
  )
  for (const doc of evidence) {
    const spec = specOf(doc)
    if (spec && ownerOf(notes, doc, input.planSpecs) === null)
      parent.set(group(featureIdFor(doc)), group(featureIdFor(spec)))
  }
  // Group root to the feature id it created.
  const created = new Map<string, string>()
  const ids = new Map<DocRef, string>()
  for (const doc of evidence) {
    const owner = ownerOf(notes, doc, input.planSpecs)
    if (owner !== null) {
      ids.set(doc, owner)
      continue
    }
    const root = group(featureIdFor(doc))
    const id =
      created.get(root) ??
      uniqueId(root, [
        ...notes.map((n) => n.id),
        ...(input.forgotten ?? []).flatMap((marker) => (marker === null ? [] : [marker.id])),
        ...created.values(),
      ])
    created.set(root, id)
    ids.set(doc, id)
  }
  return ids
}

// The evidence documents belonging to feature `id`, by the same rules resolveFeature groups them with.
export function featureDocs(input: IdentityInput, id: string): DocRef[] {
  return [...memberships(input)].filter(([, owner]) => owner === id).map(([doc]) => doc)
}

export function resolveFeature(input: IdentityInput): Identity {
  const { branch, notes } = input
  const forgotten = forgottenDocuments(input)
  // The default branch never joins a feature: features with a branch of their own drop out there.
  const dropped = new Set(
    notes
      .filter(
        (n) =>
          Object.values(n.docs).some(
            (path) => path !== undefined && containsDocument(forgotten, path),
          ) ||
          (branch !== null &&
            (n.unlinked.includes(branch) ||
              (input.isDefault && n.branches.some((b) => b !== branch)))),
      )
      .map((n) => n.id),
  )
  const candidates = new Map<string, Candidate>()
  const ids = memberships(input)

  const add = (id: string, why: Why, fields: Omit<Candidate, 'id' | 'why'>) => {
    const candidate = candidates.get(id) ?? { id, why: [], ...fields }
    if (!candidate.why.includes(why)) candidate.why.push(why)
    candidate.lastChange = Math.max(candidate.lastChange, fields.lastChange)
    candidates.set(id, candidate)
  }
  const addNote = (note: NoteRef, why: Why, lastChange = note.lastChange) =>
    add(note.id, why, { lastChange, finished: note.finished })
  const addDoc = (doc: DocRef, why: Why) => {
    const time = input.docTimes[doc.path] ?? 0
    const id = ids.get(doc)
    if (id === undefined) return
    const note = notes.find((n) => n.id === id)
    if (note) return addNote(note, why, Math.max(note.lastChange, time))
    add(id, why, { lastChange: time, finished: false, create: doc })
  }

  for (const doc of input.ledgerPlans) addDoc(doc, 'ledger')
  for (const doc of input.skillDocs) addDoc(doc, 'skill')
  if (input.readDoc) addDoc(input.readDoc, 'read')
  if (branch !== null) {
    const live = notes.filter((n) => !dropped.has(n.id) && n.branches.includes(branch))
    // The default branch shows only its newest features; a tie is left to the deciding step.
    const newest = Math.max(...live.map((n) => n.lastChange))
    for (const note of live)
      if (!input.isDefault || note.lastChange === newest) addNote(note, 'linked')
  }
  for (const doc of input.writtenDocs) addDoc(doc, 'written')
  for (const doc of input.commitDocs) addDoc(doc, 'commits')

  const all = [...candidates.values()]
    .filter((c) => !dropped.has(c.id))
    .sort((a, b) => b.lastChange - a.lastChange)
  // The user's pick comes before every rule below, finished giving way included; on the default branch it is
  // still marked `?` (spec section 4).
  const picked = all.find((c) => c.id === input.chosen)
  if (picked)
    return {
      kind: 'one',
      id: picked.id,
      weak: input.isDefault,
      ...(picked.create ? { create: picked.create } : {}),
    }
  const active = all.filter((c) => !c.finished)
  const finished = all.filter((c) => c.finished)
  const switchedFrom = active.length > 0 ? finished[0]?.id : undefined
  const one = (c: Candidate, weak: boolean): Identity => ({
    kind: 'one',
    id: c.id,
    weak,
    ...(c.create ? { create: c.create } : {}),
    ...(switchedFrom !== undefined ? { switchedFrom } : {}),
  })

  const recorded = active.filter((c) => c.why.includes('ledger') || c.why.includes('skill'))
  // Whatever links it, a feature shown on the default branch is marked `?` (spec section 4).
  if (recorded.length === 1 && recorded[0]) return one(recorded[0], input.isDefault)
  const left = active.length > 0 ? active : all
  if (left.length === 1 && left[0]) {
    return one(left[0], input.isDefault || left[0].why.every((why) => why === 'read'))
  }
  if (left.length > 1) return { kind: 'choose', candidates: left }
  return { kind: 'none' }
}
