import {
  classifyDoc,
  type DocRef,
  featureDocs,
  type IdentityInput,
  resolveFeature,
} from './feature'
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
  writtenSince,
} from './gather'
import { type Io, repoFacts } from './io'
import { keyOf } from './keys'
import { type MattResult, readMatt } from './matt'
import { type FeatureState, nextAction, phaseOf } from './next'
import { branchFiles, featureFiles, paths } from './notes'
import { remember } from './remember'
import {
  type PlanInfo,
  parseLedger,
  parsePlan,
  readSuperpowers,
  repoRelative,
  type SpResult,
} from './superpowers'
import { summaryText, type View } from './text'
import type { Docs, Note, Observed, ReadOutcome, RepoFacts } from './types'

// What this session saw (spec section 4): hooks anchor paths to the event's cwd; they become repo-relative here. `observed` is
// kept for the notes across a clear; skillDocs, readDoc and writtenDocs are this session's identity evidence.
// since: epoch ms the session started or was last cleared; a document changed from then on was written in it.
export type SessionFacts = {
  observed: Observed[]
  skillDocs: string[]
  writtenDocs: string[]
  readDoc?: string
  agentsRunning: number
  agentsBeforeClear: number
  installed: Set<string>
  chosen?: string
  since: number
}

export type RefreshResult = { view: View | null; facts: RepoFacts | null }

const BUILD_SKILLS = ['superpowers:subagent-driven-development', 'superpowers:executing-plans']
const PLAN_EDITED = 'plan edited since the build started'
const UNKNOWN_BRANCH =
  'git could not tell the branch or the default branch: this branch was not linked'

function docsOf(doc: DocRef): Docs {
  switch (doc.kind) {
    case 'sp-spec':
    case 'matt-spec':
      return { spec: doc.path }
    case 'sp-plan':
      return { plan: doc.path }
    case 'matt-map':
      return { map: doc.path }
    case 'matt-ticket':
      return { tickets: `${doc.folder}/issues/` }
  }
}

async function readPlan(io: Io, root: string, plan: string): Promise<PlanInfo | null> {
  const r = await io.read(`${root}/${plan}`)
  return r.ok ? parsePlan(r.text) : null
}

const newest = (list: Observed[], is: (o: Observed) => boolean) =>
  list
    .filter(is)
    .reduce<Observed | undefined>((a, o) => (a === undefined || o.at > a.at ? o : a), undefined)

async function currentDocuments(
  io: Io,
  root: string,
  input: IdentityInput,
  base: Note,
  observedNow: Observed[],
) {
  const members = new Set(featureDocs(input, base.id).map((doc) => doc.path))
  const own = (docs: DocRef[]) => docs.filter((doc) => members.has(doc.path))
  const starts = [...base.observed, ...observedNow.filter((o) => members.has(o.doc))].flatMap(
    (o) => {
      const doc = classifyDoc(o.doc, root)
      return doc === null ? [] : [{ docs: docsOf(doc), at: Date.parse(o.at) }]
    },
  )
  // A ledger-selected plan outlives its ledger; only a later start can supersede that selection.
  if (base.last?.plan !== undefined && base.last.plan === base.docs.plan)
    starts.push({ docs: { plan: base.last.plan }, at: Date.parse(base.last.seen) })
  // Strongest first; untimed session lists are collected in encounter order, so their last entry wins.
  const ranked = [
    ...own(input.ledgerPlans).map(docsOf),
    ...starts
      .reverse()
      .sort((a, b) => b.at - a.at)
      .map((s) => s.docs),
    ...own(input.skillDocs).reverse().map(docsOf),
    ...own(input.writtenDocs).reverse().map(docsOf),
    ...own(input.readDoc ? [input.readDoc] : []).map(docsOf),
    base.docs,
    ...own(input.commitDocs).map(docsOf),
  ]
  const docs: Docs = Object.assign({}, ...ranked.reverse())
  const read = docs.plan === undefined ? null : await io.read(`${root}/${docs.plan}`)
  const plan = read?.ok ? parsePlan(read.text) : null
  const planUnreadable = read === null || read.ok || read.why === 'missing' ? undefined : read.why
  // A plan and its referenced spec are one choice, before selecting the Matt reader or observations.
  if (plan?.spec) docs.spec = repoRelative(plan.spec, root)
  const folder = [docs.spec, docs.map, docs.tickets]
    .map((path) => /^(\.scratch\/[^/]+)\//.exec(path ?? '')?.[1])
    .find((path) => path !== undefined)
  if (folder !== undefined) {
    for (const kind of ['spec', 'map'] as const)
      if (docs[kind] === undefined && (await io.mtimeMs(`${root}/${folder}/${kind}.md`)) !== null)
        docs[kind] = `${folder}/${kind}.md`
  }
  return { docs, plan, planUnreadable, folder }
}

// Stops at the first failed write and throws, so `seen` never dates a summary not all written; the caller shows `?`.
async function writeAll(io: Io, dir: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files))
    if (!(await io.write(`${dir}/${name}`, text))) throw new Error(`not written: ${dir}/${name}`)
}

async function writeSummary(
  io: Io,
  facts: RepoFacts,
  view: View,
  featureId: string,
  watch: string[],
) {
  await writeAll(
    io,
    paths(facts.commonDir).branch(facts.branch, facts.root),
    branchFiles({
      featureId,
      name: facts.branch ?? facts.root,
      seen: (await io.now()) / 1000,
      ...summaryText(view),
      watch,
    }),
  )
}

// Spec section 6: read the evidence, decide the feature, write its note and this branch's summary.
export async function refresh(io: Io, s: SessionFacts): Promise<RefreshResult> {
  const facts = await repoFacts(io)
  if (facts === null) return { view: null, facts: null }
  const { root } = facts
  // Identity is the canonical branch. Unknown (undefined) is neither detached nor "not the default": it shows
  // weak and links nothing, and only a confirmed default branch drops features with a branch of their own.
  const known = facts.branchRef !== undefined && facts.defaultName !== undefined
  const branch = facts.branchRef?.startsWith('refs/heads/')
    ? facts.branchRef.slice('refs/heads/'.length)
    : null
  const isDefault = known && branch !== null && branch === facts.defaultName
  const linkable = known ? branch : null
  const { notes, invalid, finished } = await readNotes(io, paths(facts.commonDir).root)
  // A ledger is identity evidence only when its header names its plan-path's plan (spec section 4 rule 1).
  const ledgers: { dir: string; plan: string; read: ReadOutcome; matches: boolean }[] = []
  for (const l of await ledgerDirs(io, root)) {
    const read = await io.read(`${l.dir}/progress.md`)
    const parsed = read.ok ? parseLedger(read.text) : null
    const matches =
      parsed !== null &&
      'plan' in parsed &&
      repoRelative(parsed.plan, root) === repoRelative(l.plan, root)
    ledgers.push({ ...l, read, matches })
  }
  const commits = await branchCommits(io, facts)
  // null is no history of its own only on the confirmed default branch; elsewhere git could not tell.
  const ownCommits = commits ?? (isDefault ? [] : null)
  const observedNow = s.observed.map((o) => ({ ...o, doc: repoRelative(o.doc, root) }))

  const classify = (list: string[]) => list.flatMap((p) => classifyDoc(p, root) ?? [])
  const ledgerPlans = classify(ledgers.filter((l) => l.matches).map((l) => l.plan))
  const skillDocs = classify(s.skillDocs)
  const readDoc = classify(s.readDoc === undefined ? [] : [s.readDoc])[0]
  const written = classify(s.writtenDocs).map((doc) => doc.path)
  const writtenDocs = classify(await writtenSince(io, root, s.since, written))
  const commitDocs = classify((commits ?? []).flatMap((c) => c.files))
  const evidence = [
    ...ledgerPlans,
    ...skillDocs,
    ...(readDoc ? [readDoc] : []),
    ...writtenDocs,
    ...commitDocs,
  ]
  const planSpecs: Record<string, string> = {}
  const docTimes: Record<string, number> = {}
  for (const doc of evidence) {
    const at = await io.mtimeMs(`${root}/${doc.path}`)
    if (at !== null) docTimes[doc.path] = at
    const spec = doc.kind === 'sp-plan' ? (await readPlan(io, root, doc.path))?.spec : undefined
    if (spec) planSpecs[doc.path] = repoRelative(spec, root)
  }
  const refs = await noteRefs(io, root, notes, finished)
  const input: IdentityInput = {
    branch,
    isDefault,
    notes: refs,
    ledgerPlans,
    skillDocs,
    ...(readDoc ? { readDoc } : {}),
    writtenDocs,
    commitDocs,
    planSpecs,
    docTimes,
  }
  let identity = resolveFeature(input)
  const chosen =
    identity.kind === 'choose' ? identity.candidates.find((c) => c.id === s.chosen) : undefined
  if (chosen)
    identity = {
      kind: 'one',
      id: chosen.id,
      weak: false,
      ...(chosen.create ? { create: chosen.create } : {}),
    }
  if (identity.kind === 'none') {
    // No candidate shows nothing (spec section 4 rule 7): an earlier summary here must not print. An empty
    // message is one the hook rejects; a branch with no summary gets no folder.
    const dir = paths(facts.commonDir).branch(facts.branch, root)
    if ((await io.mtimeMs(`${dir}/message`)) !== null) await writeAll(io, dir, { message: '' })
    return { view: null, facts }
  }

  const agents = { agentsRunning: s.agentsRunning, agentsBeforeClear: s.agentsBeforeClear }
  // The label only: detached when git confirmed it, unknown when it could not tell. Keys stay as the hook's.
  const label = facts.branch ?? (facts.branchRef === null ? null : undefined)
  const at = { branch: label, ...(facts.head === null ? { noCommits: true } : {}) }
  if (identity.kind === 'choose') {
    const view: View = { kind: 'choose', ...at, candidates: identity.candidates, ...agents }
    await writeSummary(io, facts, view, '', [])
    return { view, facts }
  }

  const { id, switchedFrom } = identity
  const prev = notes.find((n) => n.id === id) ?? null
  const base: Note = prev ?? {
    version: 1,
    id,
    branches: [],
    unlinked: [],
    tips: {},
    docs: {},
    planTasks: [],
    observed: [],
    last: null,
  }
  const { docs, plan, planUnreadable, folder } = await currentDocuments(
    io,
    root,
    input,
    base,
    observedNow,
  )
  const mine = (doc: string) =>
    Object.values(docs).includes(doc) || (folder !== undefined && doc.startsWith(`${folder}/`))
  const sessionObserved = observedNow.filter((o) => mine(o.doc))
  const observed = [...base.observed, ...sessionObserved]
  const tasks = ownCommits === null ? null : taskNumbers(ownCommits)

  const own = ledgers.find(
    (l) => docs.plan !== undefined && repoRelative(l.plan, root) === docs.plan,
  )
  const previous = docs.plan !== undefined && base.last?.plan === docs.plan ? base.last : null
  const savedSource =
    previous?.source !== undefined && /^(?:\/|[A-Za-z]:\/)/.test(previous.source)
      ? previous.source
      : undefined
  let ledgerPath = own === undefined ? undefined : `${own.dir}/progress.md`
  let ledgerRoot = root
  let read: ReadOutcome | null = own?.read ?? null
  if (read === null || (!read.ok && read.why === 'missing')) {
    // Absence in this worktree says nothing about a snapshot taken in another one.
    if (savedSource !== undefined) {
      ledgerPath = savedSource
      ledgerRoot = previous?.sourceRoot ?? root
      read = await io.read(savedSource)
    } else if (
      previous?.ledgerSeen ||
      (base.last?.ledgerSeen && base.last.plan === undefined && base.docs.plan === docs.plan)
    ) {
      read = { ok: false, why: 'error' }
    }
  }
  const ledger = read === null || (!read.ok && read.why === 'missing') ? null : read
  let sp: SpResult | null = null
  if (docs.plan !== undefined)
    sp = readSuperpowers({
      planPath: docs.plan,
      plan,
      ...(planUnreadable === undefined ? {} : { planUnreadable }),
      ledger,
      ...(ledgerPath === undefined ? {} : { ledgerPath: repoRelative(ledgerPath, root) }),
      ledgerRoot,
      repoRoot: root,
      previous,
      taskCommits: tasks,
    })
  else if (docs.spec !== undefined && classifyDoc(docs.spec, root)?.kind === 'sp-spec')
    sp = {
      library: 'superpowers',
      docs: { spec: docs.spec },
      items: [],
      phase: 'design',
      weak: false,
      notes: [],
      allComplete: false,
      ledgerSeen: false,
      currentLedger: false,
    }

  let matt: MattResult | null = null
  let ticketsUnknown = false
  let ticketsDir: string | undefined
  if (folder !== undefined) {
    const build = await buildBranch(io, base, facts)
    const found = build === null ? null : await readTickets(io, folder, facts, build, base.branches)
    const tickets = found?.tickets ?? null
    const counted: (Observed & { commitsSince: number | null })[] = []
    for (const o of observed) counted.push({ ...o, commitsSince: await commitsSince(io, o.head) })
    matt = readMatt({
      folder,
      hasSpec: docs.spec === `${folder}/spec.md`,
      hasMap: docs.map === `${folder}/map.md`,
      tickets,
      unreadable: found?.unreadable ?? [],
      observed: counted,
      relatedKeys: ownCommits === null ? null : relatedKeys(ownCommits, tickets ?? []),
    })
    if (matt.docs.tickets !== undefined) docs.tickets = matt.docs.tickets
    ticketsUnknown = tickets === null
    // The folder a new ticket lands in, watched even while empty; until it is there, the feature's folder.
    const issues = `${folder}/issues`
    ticketsDir = (await io.mtimeMs(`${root}/${issues}`)) === null ? folder : issues
  }

  const hasOwnCommits = commits !== null && commits.length > 0
  const tips =
    linkable !== null && hasOwnCommits && facts.head !== null
      ? { ...base.tips, [linkable]: facts.head }
      : base.tips
  const buildSkill = newest(observed, (o) => BUILD_SKILLS.includes(o.skill))?.skill
  const implementSpecAt = newest(
    observed,
    (o) => o.skill === 'mattpocock-skills:implement-spec',
  )?.at
  const merged = await mergedState(io, { ...base, tips }, facts)
  const state: FeatureState = {
    id,
    sp,
    matt,
    merged,
    ...agents,
    ...(buildSkill === undefined ? {} : { buildSkill }),
    ...(implementSpecAt === undefined ? {} : { implementSpecAt }),
    taskCommitsWithoutLedger: tasks,
  }
  const headline = phaseOf(state)
  const now = await io.now()
  const kept = remember(
    {
      prev,
      prevInvalid: invalid.includes(keyOf(id)),
      id,
      branch: linkable,
      head: facts.head,
      isDefault,
      hasOwnCommits,
      docs,
      planHeadings: plan === null ? null : plan.tasks.map((t) => `Task ${t.n}: ${t.title}`),
      sp,
      headline,
      sessionObserved,
      ...(ledger === null || ledgerPath === undefined
        ? {}
        : { source: ledgerPath, sourceRoot: ledgerRoot }),
      now: new Date(now),
    },
    finished[id] ?? null,
  )
  const notices = [
    ...kept.notices,
    ...(known ? [] : [UNKNOWN_BRANCH]),
    ...(switchedFrom === undefined ? [] : [`switched to ${id}; ${switchedFrom} is done`]),
  ]
  const weak =
    headline.weak || identity.weak || !known || ticketsUnknown || notices.includes(PLAN_EDITED)
  const view: View = {
    kind: 'feature',
    featureId: id,
    ...at,
    headline: { ...headline, weak },
    next: nextAction(state, s.installed),
    sp,
    matt,
    merged,
    docs: kept.note.docs,
    ...agents,
    notices,
    ...(switchedFrom === undefined ? {} : { switchedFrom }),
  }

  await writeAll(io, paths(facts.commonDir).feature(id), featureFiles(kept.note, kept.finishedAt))
  const d = kept.note.docs
  const abs = (p?: string) => (p === undefined ? [] : [`${root}/${p.replace(/\/$/, '')}`])
  const watch = [
    ...abs(d.spec),
    ...abs(d.plan),
    ...(ledger === null || ledgerPath === undefined ? [] : [ledgerPath]),
    ...abs(d.map),
    ...abs(ticketsDir),
  ]
  await writeSummary(io, facts, view, id, watch)
  return { view, facts }
}
