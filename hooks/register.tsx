import type {
  CommandRunResult,
  EngineInterface,
  Register,
  RenderSurface,
  UiPressArgument,
} from 'claude-code'
import { absolutePath, classifyDoc, docFromArgs } from '../src/feature'
import { readNotes } from '../src/gather'
import { answered, type Io, MAX_READ } from '../src/io'
import { type ForgetMarker, featureFiles, paths } from '../src/notes'
import { refresh, type SessionFacts } from '../src/refresh'
import { paneTree } from '../src/render'
import { bandText, cut, plainText, type View } from '../src/text'
import type { Note, RepoFacts } from '../src/types'

const NO_GIT = { code: -1, out: '', truncated: false }

// Every file whereami writes: an absolute <common dir>/whereami/<branches|features>/<key>/<file>.
const PLACE = /^((?:\/|[A-Za-z]:\/).*)\/whereami\/(?:branches|features)\/[^/]+\/[^/]+$/

// Where path lands, every link followed; for a path not there yet, where its nearest existing folder lands
// plus the rest. Null when that cannot be told (a stat that fails on a path that exists).
async function land($: EngineInterface, path: string): Promise<string | null> {
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => null)
  if (stat !== null) return stat.realPath?.replace(/\\/g, '/').replace(/\/$/, '') ?? null
  const cut = path.lastIndexOf('/')
  if (cut <= 0 || (await $.fs.exists(path))) return null
  const dir = await land($, path.slice(0, cut))
  return dir === null ? null : `${dir}/${path.slice(cut + 1)}`
}

// Why path must not be written, or null: its folder must land below where <common dir>/whereami/ lands, and
// the file itself, if there, be a plain file and no link. Resolved, not matched by name: a case alias
// (MESSAGE for message) is the same file. A failed call rejects.
// ponytail: checked, then written; a link swapped in between still lands. The SDK has no no-follow write.
async function misplaced($: EngineInterface, path: string): Promise<string | null> {
  const m = PLACE.exec(path)
  if (m === null) return 'not a whereami file'
  const top = await land($, m[1] ?? '')
  const dir = await land($, path.slice(0, path.lastIndexOf('/')))
  if (top === null || dir === null || !dir.startsWith(`${top}/whereami/`))
    return `lands outside whereami/: ${dir}`
  const own = await $.fs.stat(path).catch(() => null)
  if (own === null ? await $.fs.exists(path) : own.isLink || own.kind !== 'file')
    return 'not a plain file'
  return null
}

// A failed inspection is missing only when absence is confirmed.
async function inspect($: EngineInterface, path: string) {
  try {
    return await $.fs.stat(path)
  } catch (err) {
    if (!(await $.fs.exists(path).catch(() => true))) return null
    throw new Error(`not looked at: ${path}: ${err}`)
  }
}

// The Io over $. Here, not in src/io.ts: the engine follows $ into a function of this file, never across an import.
function makeIo($: EngineInterface, cwd: string): Io {
  return {
    // A missing $.process throws inside the try as a denial does.
    git: async (args, stdin) => {
      try {
        const r = await $.process.run(['git', ...args], { cwd, stdin, timeoutMs: 10000 })
        return { code: r.exitCode, out: r.stdout, truncated: r.isStdoutTruncated }
      } catch {
        return NO_GIT
      }
    },
    read: async (path) => {
      // A failed stat is missing only when the path is confirmed absent; a denied or failed look is unreadable.
      const stat = await $.fs.stat(path).catch(() => null)
      if (stat === null)
        return (await $.fs.exists(path).catch(() => true))
          ? { ok: false, why: 'error' }
          : { ok: false, why: 'missing' }
      if (stat.kind !== 'file') return { ok: false, why: 'error' }
      if (stat.size > MAX_READ) return { ok: false, why: 'too-big' }
      try {
        const text = await $.fs.read(path)
        return text.includes('\0') ? { ok: false, why: 'not-text' } : { ok: true, text }
      } catch {
        return { ok: false, why: 'error' }
      }
    },
    write: async (path, text) => {
      try {
        const why = await misplaced($, path)
        if (why !== null) throw new Error(why)
        await $.fs.write(path, text)
        return true
      } catch (err) {
        $.ui.log(`whereami: not written: ${path}: ${err}`, { to: 'debug' })
        return false
      }
    },
    list: async (dir) => {
      try {
        return (await $.fs.list(dir)).map((e) => e.name)
      } catch (err) {
        if (!(await $.fs.exists(dir).catch(() => true))) return []
        throw new Error(`not listed: ${dir}: ${err}`)
      }
    },
    mtimeMs: async (path) => (await inspect($, path))?.mtimeMs ?? null,
    kind: async (path) => (await inspect($, path))?.kind ?? null,
    now: () => $.clock.now(),
  }
}

const BAND = { plugin: 'whereami', key: 'band' } as const
const PANE = 'whereami'
const FAILED = 'whereami · ?'
const THROTTLE = 1000
const LIBRARY = /^(?:superpowers|mattpocock-skills):/
const RUNNING = ['pending', 'running', 'waiting']
const WRITES = ['Write', 'Edit', 'NotebookEdit', 'Bash']

// Installed command names, without the slash; none when the list cannot be read.
async function installedCommands($: EngineInterface): Promise<Set<string>> {
  try {
    return new Set((await $.command.list()).map((c) => c.name.replace(/^\//, '')))
  } catch {
    return new Set()
  }
}

// Ids of the session's agents still running; null when the list is denied (it throws under `claude -p`).
async function runningAgents($: EngineInterface): Promise<string[] | null> {
  try {
    return (await $.agent.list()).filter((a) => RUNNING.includes(a.status)).map((a) => a.id)
  } catch {
    return null
  }
}

const fresh = (since: number, installed = new Set<string>()): SessionFacts => ({
  observed: [],
  skillDocs: [],
  writtenDocs: [],
  agentsRunning: 0,
  agentsBeforeClear: 0,
  installed,
  since,
})

// The repository root of a directory, '' outside one or when git cannot tell.
async function toplevel($: EngineInterface, dir: string): Promise<string> {
  const r = await makeIo($, dir).git(['rev-parse', '--path-format=absolute', '--show-toplevel'])
  return (answered(r) && /^((?:\/|[A-Za-z]:\/)[^\r\n]*)\r?\n$/.exec(r.out)?.[1]) || ''
}

// What this session saw and drew. A hot reload starts these over and re-runs session.start.
let cwd = ''
let session = fresh(0)
let facts: RepoFacts | null = null
let view: View | null = null
let forgetMarker: ForgetMarker | null = null
// Rendered actions and in-flight choices belong to the identity session that produced them.
let generation = 0
let viewGeneration = 0
let beforeClear = new Set<string>()
// Section 4 rule 2: open from a library start without a document until the main loop's turn ends.
let reading = false
// One queue: every refresh and every note change starts after the one before it ended, so a change never
// lands between a refresh's read and its write. `tail` settles once the queue is empty.
let tail: Promise<unknown> = Promise.resolve()
// The scheduler: one loop at a time. A request while it waits joins that run; one while it runs asks for
// one follow-up. `last` is when the last run started, scheduled or awaited: none at first, so the start's
// runs at once.
let busy = false
let waiting = false
let again = false
let failed = false
let last = Number.NEGATIVE_INFINITY
// What the last press in the pane came to, shown at its top; null when there is nothing to say.
let notice: string | null = null

async function run(
  $: EngineInterface,
  chosen?: SessionFacts['chosen'],
  at = generation,
): Promise<boolean> {
  try {
    let wait = last + THROTTLE - (await $.clock.now())
    while (wait > 0) {
      await $.clock.sleep(wait)
      wait = last + THROTTLE - (await $.clock.now())
    }
    last = await $.clock.now()
    // The session's directory now, so a worktree switch is followed; the start's when it cannot be told.
    const dir = await $.session.cwd().catch(() => cwd)
    if (at !== generation) return false
    const r = await refresh(makeIo($, dir), chosen === undefined ? session : { ...session, chosen })
    if (at !== generation) return false
    facts = r.facts
    view = r.view
    forgetMarker = r.forget ?? null
    viewGeneration = at
    if (failed) notice = null
    failed = false
    await $.state.set(BAND, view === null ? '' : bandText(view, Number.POSITIVE_INFINITY))
  } catch (err) {
    if (!failed) $.ui.log(`whereami: refresh failed: ${err}`, { to: 'debug' })
    if (at !== generation) return false
    failed = true
    view = null
    forgetMarker = null
    notice = 'refresh failed; open /whereami to retry'
    await $.state.set(BAND, FAILED).catch(() => undefined)
  }
  $.ui.invalidate('ui.render')
  return !failed
}

// Runs job once every job queued before it has ended; a failed job never stops the ones after it.
function serial<T>(job: () => Promise<T>): Promise<T> {
  const done = tail.then(job)
  tail = done.catch(() => undefined)
  return done
}

// A scheduled refresh when its turn comes: false, and nothing run, while one ran less than a second ago.
async function due($: EngineInterface) {
  if (last + THROTTLE > (await $.clock.now())) return false
  waiting = false
  await run($)
  return true
}

async function loop($: EngineInterface) {
  try {
    do {
      again = false
      waiting = true
      // Queued with no await before it on the first run, so a session ending right after its start sees it.
      while (!(await serial(() => due($)))) {
        const wait = last + THROTTLE - (await $.clock.now())
        if (wait > 0) await $.clock.sleep(wait)
      }
    } while (again)
  } catch (err) {
    $.ui.log(`whereami: refresh not run: ${err}`, { to: 'debug' })
  } finally {
    busy = false
    waiting = false
  }
}

// Never awaited by a hook, so a refresh never delays a tool, turn or session (spec section 6).
function schedule($: EngineInterface) {
  if (!busy) {
    busy = true
    loop($)
  } else if (!waiting) again = true
}

async function currentDirectory($: EngineInterface): Promise<string | null> {
  try {
    return await $.session.cwd()
  } catch (err) {
    $.ui.log(`whereami: current directory unavailable: ${err}`, { to: 'debug' })
    return null
  }
}

async function rootNow($: EngineInterface) {
  const dir = await currentDirectory($)
  return dir === null ? null : { dir, root: await toplevel($, dir) }
}

async function recount($: EngineInterface) {
  const running = await runningAgents($)
  if (running === null) return
  session.agentsRunning = running.length
  session.agentsBeforeClear = running.filter((id) => beforeClear.has(id)).length
}

// A library skill started: with a document it is observed; without one the read window opens.
async function started($: EngineInterface, skill: string, args: string) {
  const at = await rootNow($)
  if (at === null) return
  const { dir, root } = at
  const doc = docFromArgs(skill, args, root, dir)
  if (doc === null) {
    reading = true
    return
  }
  const path = `${root}/${doc.path}`
  session.skillDocs.push(path)
  session.observed.push({
    skill,
    doc: path,
    branch: facts?.branch ?? null,
    head: facts?.head ?? null,
    at: new Date(await $.clock.now()).toISOString(),
  })
}

// The branch a note may list: as refresh links it, none when detached or git could not tell.
function linkable(f: RepoFacts): string | null {
  if (f.defaultName === undefined || !f.branchRef?.startsWith('refs/heads/')) return null
  return f.branchRef.slice('refs/heads/'.length)
}

// Rewrites the notes `change` alters (its note.json and branches files); false when there is no branch to
// link. A file not written rejects.
async function relink($: EngineInterface, change: (n: Note, branch: string) => Note | null) {
  const branch = facts === null ? null : linkable(facts)
  if (facts === null || branch === null) return false
  const io = makeIo($, cwd)
  const where = paths(facts.commonDir)
  for (const note of (await readNotes(io, where.root)).notes) {
    const next = change(note, branch)
    if (next === null) continue
    const files = featureFiles(next, null)
    for (const name of ['note.json', 'branches'] as const) {
      const path = `${where.feature(note.id)}/${name}`
      if (!(await io.write(path, files[name]))) throw new Error(`not written: ${path}`)
    }
  }
  return true
}

const without = (list: string[], b: string) => list.filter((x) => x !== b)

// "This is <id>": that note lists the branch, no other note does (spec section 4 rule 6). Once saved, the
// pick holds for this session on this repository's branch (or this detached worktree), not a later switch.
async function choose($: EngineInterface, id: string, at: number) {
  if (facts === null || facts.branchRef === undefined)
    throw new Error('branch unavailable; open /whereami and try again')
  const chosen = { id, commonDir: facts.commonDir, branchRef: facts.branchRef, root: facts.root }
  await relink($, (n, b) => {
    if (n.id === id)
      return n.branches.includes(b) && !n.unlinked.includes(b)
        ? null
        : { ...n, branches: [...without(n.branches, b), b], unlinked: without(n.unlinked, b) }
    return n.branches.includes(b) ? { ...n, branches: without(n.branches, b) } : null
  })
  if (at !== generation) throw new Error('stale action; open /whereami and try again')
  // A candidate need not have a note yet. Refresh with a provisional pick; publish it only once
  // that note and its branch files have actually been saved.
  const ok = await run($, chosen, at)
  if (at !== generation) throw new Error('stale action; open /whereami and try again')
  if (!ok) throw new Error('refresh failed')
  session.chosen = chosen
}

// "Not this feature": the branch leaves the note and stays out of it.
async function unlink($: EngineInterface) {
  const id = view?.kind === 'feature' ? view.featureId : null
  const done = await relink($, (n, b) =>
    n.id === id
      ? { ...n, branches: without(n.branches, b), unlinked: [...without(n.unlinked, b), b] }
      : null,
  )
  if (!done) throw new Error('no branch here to unlink')
}

// Marks the shown feature forgotten (the hook deletes it at the next start) and clears the view and band.
// Null when no feature is shown; a marker not written rejects.
async function forget($: EngineInterface): Promise<string | null> {
  if (view?.kind !== 'feature' || facts === null) return null
  const id = view.featureId
  if (forgetMarker?.id !== id || forgetMarker.documents.length === 0)
    throw new Error('feature documents unavailable; open /whereami and try again')
  const path = `${paths(facts.commonDir).feature(id)}/forget`
  const marker = `${JSON.stringify({ version: 1, ...forgetMarker })}\n`
  if (!(await makeIo($, cwd).write(path, marker))) throw new Error(`not written: ${path}`)
  view = null
  forgetMarker = null
  await $.state.set(BAND, '').catch(() => undefined)
  return id
}

// Spec section 7 "Drafting": only a box holding exactly '' is filled; the user's text is never touched and
// nothing is submitted. Returns the notice to show, null when the command is in the box.
async function draft($: EngineInterface, command: string, surface: RenderSurface) {
  const box = await $.prompt.read().catch(() => null)
  let refused = false
  if (box?.text === '') {
    const r = await $.prompt.fill({ text: command }).catch(() => ({ isFilled: false as const }))
    if (r.isFilled) return null
    if ('refusal' in r && r.refusal === 'dialog') return 'close the dialog, then press Draft again'
    refused = true
  }
  const copied = await $.ui.copy({ text: command, surface }).catch(() => ({ isCopied: false }))
  if (!copied.isCopied) return `copy this command: ${command}`
  return refused
    ? 'copied: this window has no prompt box'
    : 'your prompt has text, so the command was copied instead'
}

function sameAction(p: UiPressArgument, shown: View | null, at: RepoFacts | null): boolean {
  if (
    failed ||
    shown === null ||
    view === null ||
    at === null ||
    facts === null ||
    at.root !== facts.root ||
    at.commonDir !== facts.commonDir ||
    at.branchRef !== facts.branchRef ||
    shown.kind !== view.kind
  )
    return false
  if (shown.kind === 'choose' && view.kind === 'choose')
    return (
      p.element.startsWith('choose:') &&
      shown.candidates.some((c) => `choose:${c.id}` === p.element) &&
      view.candidates.some((c) => `choose:${c.id}` === p.element)
    )
  if (shown.kind !== 'feature' || view.kind !== 'feature' || shown.featureId !== view.featureId)
    return false
  if (p.element === 'draft')
    return shown.next?.command !== undefined && shown.next.command === view.next?.command
  if (p.element.startsWith('choose:'))
    return (
      shown.switchedFrom !== undefined &&
      shown.switchedFrom === view.switchedFrom &&
      p.element === `choose:${shown.switchedFrom}`
    )
  return p.element === 'forget' || p.element === 'unlink'
}

// Keep the rendered target across the queue wait; a replacement feature is never an implicit target.
async function pressed(
  $: EngineInterface,
  p: UiPressArgument,
  shown: View | null,
  at: RepoFacts | null,
  renderedGeneration: number,
) {
  try {
    if (renderedGeneration !== generation || !sameAction(p, shown, at))
      throw new Error('stale action; open /whereami and try again')
    if (p.element === 'draft') {
      const command = shown?.kind === 'feature' ? shown.next?.command : undefined
      notice = command === undefined ? null : await draft($, command, p.surface)
    } else if (p.element === 'forget') {
      const id = await forget($)
      notice = id === null ? null : `forgot ${id}`
    } else if (p.element === 'unlink' || p.element.startsWith('choose:')) {
      if (p.element === 'unlink') {
        await unlink($)
        if (!(await run($))) throw new Error('refresh failed')
      } else await choose($, p.element.slice('choose:'.length), renderedGeneration)
      notice = null
    }
  } catch (err) {
    $.ui.log(`whereami: ${p.element} failed: ${err}`, { to: 'debug' })
    notice = `not done: ${err instanceof Error ? err.message : err}`
  }
  $.ui.invalidate('ui.render')
}

// `/whereami` and `/whereami forget`, in their turn in the queue. The text is the model's to read: ids, paths,
// counts, statuses and the next command only (plainText), never document, ticket or ledger text.
async function whereami($: EngineInterface, args: string): Promise<CommandRunResult> {
  const ok = await run($)
  if (!ok) return { text: 'whereami: refresh failed' }
  notice = null
  if (args.trim() === 'forget') {
    const id = view?.kind === 'feature' ? view.featureId : null
    const text = await forget($).then(
      (forgot) => (forgot === null ? 'whereami: nothing to forget' : `whereami: forgot ${forgot}`),
      () => `whereami: could not forget ${id}`,
    )
    $.ui.invalidate('ui.render')
    return { text }
  }
  await $.ui
    .open({ id: PANE, title: 'whereami' })
    .catch((err) => $.ui.log(`whereami: pane not opened: ${err}`, { to: 'debug' }))
  return { text: plainText(view) }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    generation++
    cwd = e.cwd
    session = fresh(await $.clock.now(), await installedCommands($))
    beforeClear = new Set()
    reading = false
    await $.command
      .register({
        name: 'whereami',
        description: 'Where this feature stands, and the next step',
        argumentHint: '[forget]',
      })
      .catch((err) => $.ui.log(`whereami: /whereami not registered: ${err}`, { to: 'debug' }))
    schedule($)
    return result
  })

  on('session.end', async ($, e, next) => {
    const result = await next(e)
    if (e.reason !== 'clear') {
      // What the queue holds finishes, so a summary is whole; a refresh waiting out the second is not run.
      await tail
      return result
    }
    generation++
    beforeClear = new Set((await runningAgents($)) ?? [])
    session = { ...session, skillDocs: [], writtenDocs: [], since: await $.clock.now() }
    delete session.readDoc
    delete session.chosen
    reading = false
    await recount($)
    schedule($)
    return result
  })

  on('command.run', async ($, e, next) => {
    if (e.command === 'whereami') return serial(() => whereami($, e.args))
    const result = await next(e)
    if (LIBRARY.test(e.command)) {
      await started($, e.command, e.args)
      schedule($)
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    // A refused or failed call is evidence of nothing; one that may have changed files still refreshes.
    const ok = result.deny === undefined && result.isError === undefined
    const main = e.agentId === undefined
    if (ok && e.tool === 'Skill' && main && LIBRARY.test(e.skill)) {
      await started($, e.skill, e.args ?? '')
      schedule($)
    } else if (ok && e.tool === 'Read' && main && reading) {
      const at = await rootNow($)
      const doc = at === null ? null : classifyDoc(e.file_path, at.root, at.dir)
      if (at !== null && doc !== null) {
        session.readDoc = `${at.root}/${doc.path}`
        reading = false
        schedule($)
      }
    } else if (ok && (e.tool === 'Write' || e.tool === 'Edit')) {
      const dir = await currentDirectory($)
      if (dir !== null) session.writtenDocs.push(absolutePath(e.file_path, dir))
    }
    if (WRITES.includes(e.tool)) schedule($)
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    await recount($)
    schedule($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) reading = false
    else await recount($)
    schedule($)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const shown = view
    const at = facts
    const renderedGeneration = viewGeneration
    return paneTree($.ui.resolve(e), shown, notice, (p) => {
      serial(() => pressed($, p, shown, at, renderedGeneration))
    })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const { value: band = '' } = await $.state.get(BAND)
    if (band === '' || e.props.hasSurvey) return below
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text>
          {view === null ? cut(band, e.props.bodyColumns) : bandText(view, e.props.bodyColumns)}
        </Text>
        {below}
      </Box>
    )
  })
}
