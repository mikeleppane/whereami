import type { EngineInterface, Register } from 'claude-code'
import { absolutePath, classifyDoc, docFromArgs } from '../src/feature'
import { answered, type Io, MAX_READ } from '../src/io'
import { refresh, type SessionFacts } from '../src/refresh'
import { bandText, cut, type View } from '../src/text'
import type { RepoFacts } from '../src/types'

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
let beforeClear = new Set<string>()
// Section 4 rule 2: open from a library start without a document until the main loop's turn ends.
let reading = false
// The scheduler: one loop at a time. A request while it waits joins that run; one while it runs asks for
// one follow-up. `last` is when the last run started: none at first, so the start's runs at once.
// `executing` is the run under way, never the wait before it.
let busy = false
let waiting = false
let again = false
let failed = false
let last = Number.NEGATIVE_INFINITY
let executing: Promise<void> | null = null

async function run($: EngineInterface) {
  try {
    last = await $.clock.now()
    // The session's directory now, so a worktree switch is followed; the start's when it cannot be told.
    const r = await refresh(makeIo($, await $.session.cwd().catch(() => cwd)), session)
    facts = r.facts
    view = r.view
    failed = false
    await $.state.set(BAND, view === null ? '' : bandText(view, Number.POSITIVE_INFINITY))
  } catch (err) {
    if (!failed) $.ui.log(`whereami: refresh failed: ${err}`, { to: 'debug' })
    failed = true
    view = null
    await $.state.set(BAND, FAILED).catch(() => undefined)
  }
}

async function loop($: EngineInterface) {
  try {
    do {
      again = false
      if (last !== Number.NEGATIVE_INFINITY) {
        waiting = true
        const wait = last + THROTTLE - (await $.clock.now())
        if (wait > 0) await $.clock.sleep(wait)
        waiting = false
      }
      // Set with no await before it on the first run, so a session ending right after its start sees it.
      executing = run($)
      await executing
      executing = null
    } while (again)
  } catch (err) {
    $.ui.log(`whereami: refresh not run: ${err}`, { to: 'debug' })
  } finally {
    busy = false
    waiting = false
    executing = null
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

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
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
      // A refresh under way finishes, so its summary is whole; one still waiting its turn is not run.
      await executing
      return result
    }
    beforeClear = new Set((await runningAgents($)) ?? [])
    session = { ...session, skillDocs: [], writtenDocs: [], since: await $.clock.now() }
    delete session.readDoc
    reading = false
    await recount($)
    schedule($)
    return result
  })

  on('command.run', async ($, e, next) => {
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
