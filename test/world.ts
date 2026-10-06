import type { AgentStatus, On } from 'claude-code'
import { type Engine, type MockClock, mock } from 'claude-code/testing'
import { serializeNote } from '../src/notes'
import type { GitResult } from '../src/types'

// Where the world's clock starts, in epoch ms.
export const NOW = Date.UTC(2026, 9, 6)

export const W = '/r/.git/whereami'

// An fs event's path as the worlds here spell it. The engine anchors it with the host's path.resolve before any
// hook sees it, so on Windows `/r/x` arrives as `D:\r\x`; these worlds are POSIX.
export const posix = (path: string) => path.replace(/^[A-Za-z]:(?=\\)/, '').replace(/\\/g, '/')

// A matcher for fs events on `path`, in either spelling.
export const onPath = (path: string) =>
  new RegExp(
    `^(?:[A-Za-z]:)?${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '[\\\\/]')}$`,
  )

// Every refresh starts with this git call: the count of refreshes run so far.
export const TOP =
  'process.run git rev-parse --path-format=absolute --show-toplevel --git-common-dir'
export const refreshes = (w: { calls: string[] }) => w.calls.filter((c) => c === TOP).length

export const bash = ($: Engine) => $.tool.call({ tool: 'Bash', command: 'ls' })

export const CHOOSE = 'whereami · 2 features could match · /whereami to choose'

// A plugin beneath whereami that draws its own band line (`<Text>below</Text>`).
export const below = (on: On) =>
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, null, 'below') as JSX.Element
  })

// A note of feature `id` linked to `branches`, owning its spec.
export const linked = (id: string, branches = ['feat/auth']) => ({
  [`${W}/features/${id}/note.json`]: serializeNote({
    version: 1,
    id,
    branches,
    unlinked: [],
    tips: {},
    docs: { spec: `docs/superpowers/specs/2026-10-01-${id}-design.md` },
    planTasks: [],
    observed: [],
    last: null,
  }),
})

// The world beneath whereami, from memory: absolute paths to text (a folder is any prefix of one), git answered
// as in fake-io.ts (a string is code 0 with that output, null is code 128), the session's agents (none: the
// list is denied, as under `claude -p`), installed commands and the prompt box. Writes land in `files` too, so
// the next refresh reads them. A file or folder changed at 0 unless `mtimes` says when; the clock starts at NOW, so only a
// file `mtimes` dates later was written in the session. `calls` records each answered op in order:
// `<op> <its path, argv or text>`, a fill's mode before its text. `cwd` can follow a worktree move; otherwise it
// is the start directory.
export function world(
  on: On,
  opts: {
    files: Record<string, string>
    git: (args: string[], stdin?: string) => GitResult | string | null
    agents?: { id: string; status: string }[]
    commands?: string[]
    prompt?: string
    mtimes?: Record<string, number>
    cwd?: () => string
  },
): { written: Record<string, string>; calls: string[]; clock: MockClock } {
  const { files } = opts
  const written: Record<string, string> = {}
  const calls: string[] = []
  let cwd = ''
  const clock = mock.clock(on, { now: NOW })
  const isDir = (path: string) => Object.keys(files).some((p) => p.startsWith(`${path}/`))
  const stat = (path: string) =>
    path in files
      ? {
          kind: 'file' as const,
          size: files[path]?.length ?? 0,
          mtimeMs: opts.mtimes?.[path] ?? 0,
          isLink: false,
        }
      : isDir(path)
        ? { kind: 'dir' as const, size: 0, mtimeMs: opts.mtimes?.[path] ?? 0, isLink: false }
        : null
  const missing = (path: string) => ({ deny: `no such file: ${path}` })

  on('fs.read', (_, e) => {
    const path = posix(e.path)
    calls.push(`fs.read ${path}`)
    const text = files[path]
    return text === undefined ? missing(path) : { value: text }
  })
  on('fs.write', (_, e) => {
    const path = posix(e.path)
    calls.push(`fs.write ${path}`)
    files[path] = e.text
    written[path] = e.text
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const path = posix(e.path)
    calls.push(`fs.list ${path}`)
    if (!isDir(path)) return missing(path)
    const names = Object.keys(files)
      .filter((p) => p.startsWith(`${path}/`))
      .map((p) => p.slice(path.length + 1).replace(/\/.*/, ''))
    return {
      value: [...new Set(names)].map((name) => {
        const s = stat(`${path}/${name}`) ?? { kind: 'file' as const, size: 0, mtimeMs: 0 }
        return { name, ...s, isLink: false }
      }),
    }
  })
  on('fs.exists', (_, e) => {
    const path = posix(e.path)
    calls.push(`fs.exists ${path}`)
    return { value: stat(path) !== null }
  })
  on('fs.stat', (_, e) => {
    const path = posix(e.path)
    calls.push(`fs.stat ${path}`)
    const s = stat(path)
    return s === null ? missing(path) : { value: e.resolve ? { ...s, realPath: path } : s }
  })
  on('process.run', (_, e) => {
    calls.push(`process.run ${e.argv.join(' ')}`)
    const [, ...args] = e.argv
    const r = opts.git(args, e.init?.stdin)
    const g =
      r === null
        ? { code: 128, out: '', truncated: false }
        : typeof r === 'string'
          ? { code: 0, out: r, truncated: false }
          : r
    return {
      value: {
        exitCode: g.code,
        stdout: g.out,
        stderr: '',
        isStdoutTruncated: g.truncated,
        isStderrTruncated: false,
      },
    }
  })
  on('command.list', () => {
    calls.push('command.list')
    return {
      value: (opts.commands ?? []).map((name) => ({
        name,
        description: '',
        source: 'plugin' as const,
      })),
    }
  })
  on('command.register', (_, e) => {
    calls.push(`command.register ${e.name}`)
    return { value: { command: e.name } }
  })
  on('agent.list', () => {
    calls.push('agent.list')
    if (opts.agents === undefined) return { deny: 'no agents in a headless run' }
    return {
      value: opts.agents.map((a) => ({
        id: a.id,
        description: '',
        type: 'general-purpose',
        status: a.status as AgentStatus,
      })),
    }
  })
  on('prompt.read', () => {
    calls.push('prompt.read')
    const text = opts.prompt ?? ''
    return { value: { text, cursor: text.length } }
  })
  on('prompt.fill', (_, e) => {
    calls.push(`prompt.fill ${e.mode} ${e.text}`)
    return { isFilled: true }
  })
  on('ui.copy', (_, e) => {
    calls.push(`ui.copy ${e.text}`)
    return { value: { isCopied: true } }
  })
  on('ui.open', (_, e) => {
    calls.push(`ui.open ${e.id}`)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => {
    cwd = e.cwd
    return { cwd }
  })
  on('session.cwd', () => ({ value: opts.cwd?.() ?? cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', (_, e) => {
    calls.push(`tool.call ${e.tool}`)
    // As the tools answer: a Read or Edit of a missing file and a Skill not installed fail.
    if (
      ((e.tool === 'Read' || e.tool === 'Edit') && !(e.file_path in files)) ||
      (e.tool === 'Skill' && !(opts.commands ?? []).includes(e.skill))
    )
      return { isError: true as const, result: `failed: ${e.tool}` }
    return { result: '', isAborted: false, turnId: 'turn-1' }
  })
  return { written, calls, clock }
}
