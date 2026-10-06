import type { EngineInterface, Register } from 'claude-code'
import { type Io, MAX_READ } from '../src/io'
import { refresh } from '../src/refresh'

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
    mtimeMs: (path) =>
      $.fs.stat(path).then(
        (s) => s.mtimeMs,
        () => null,
      ),
    now: () => $.clock.now(),
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const session = {
      observed: [],
      skillDocs: [],
      writtenDocs: [],
      agentsRunning: 0,
      agentsBeforeClear: 0,
      installed: new Set<string>(),
    }
    await refresh(makeIo($, e.cwd), session).catch((err) =>
      $.ui.log(`whereami: ${err}`, { to: 'debug' }),
    )
    return started
  })
}
