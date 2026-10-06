import { type Engine, expect, test } from 'claude-code/testing'
import { BOLD_READY_TICKET } from './fixtures/matt'
import { complete, git, HEAD, LEDGER, ledger, PLAN, repo, spWorld } from './fixtures/repo'
import { THREE_TASK_PLAN } from './fixtures/sp'
import { bash, below, CHOOSE, linked, onPath, refreshes, W, world } from './world'

const BAND = {
  plugin: 'whereami',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 3,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const

// The session starts in /r; its refresh runs once the clock is let go.
const start = async ($: Engine, clock: { settle: () => Promise<void> }) => {
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  await clock.settle()
}

// The band's lines, top first.
const band = async ($: Engine, props: { hasSurvey?: boolean; bodyColumns?: number } = {}) => {
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, ...props }, surface: 'terminal' })
  const lines = (await ui.findAll({ type: 'Text' })).map((t) => t.text)
  await ui.unmount()
  return lines
}

const typed = ($: Engine, command: string, args: string) =>
  $.command.run({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

const turnDone = (agentId: string) => ({
  answer: '',
  durationMs: 0,
  isAborted: false,
  turnId: 'turn-1',
  reason: 'answer' as const,
  agentId,
})

test('a Bash call resolves before its refresh, which redraws the band once the clock moves', async ($, on) => {
  const files = spWorld(complete(1))
  const w = world(on, { files, git: git(repo()) })
  below(on)
  await start($, w.clock)
  expect(await band($)).toEqual(['whereami · auth · build 1/3', 'below'])
  files[LEDGER] = ledger(complete(1), complete(2))
  const before = w.calls.length
  await bash($)
  expect(w.calls.slice(before).filter((c) => c.startsWith('process.run'))).toEqual([])
  await w.clock.advance(1000)
  await w.clock.settle()
  expect(await band($)).toEqual(['whereami · auth · build 2/3', 'below'])
})

test('a session that ends right after it starts waits for the refresh under way, so its summary is written', async ($, on) => {
  const w = world(on, { files: spWorld(complete(1)), git: git(repo()) })
  await $.session.start({ cwd: '/r', surface: null, isInteractive: false })
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  expect(w.written[`${W}/branches/feat%2Fauth/message`]).toContain('build 1/3')
})

test('a session that ends never waits for a refresh still waiting its turn', async ($, on) => {
  const files = spWorld(complete(1))
  const w = world(on, { files, git: git(repo()) })
  await start($, w.clock)
  files[LEDGER] = ledger(complete(1), complete(2))
  await bash($)
  const before = refreshes(w)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  expect(refreshes(w)).toBe(before)
  expect(w.written[`${W}/branches/feat%2Fauth/message`]).toContain('build 1/3')
})

test('the band stacks above what the plugins below drew, and draws only theirs under a survey', async ($, on) => {
  const w = world(on, { files: spWorld(complete(1)), git: git(repo()) })
  below(on)
  await start($, w.clock)
  expect(await band($)).toEqual(['whereami · auth · build 1/3', 'below'])
  expect(await band($, { hasSurvey: true })).toEqual(['below'])
})

test('outside a repo the band is exactly what the plugins below drew', async ($, on) => {
  const w = world(on, { files: {}, git: () => null })
  below(on)
  await start($, w.clock)
  expect(refreshes(w)).toBe(1)
  expect(await band($)).toEqual(['below'])
})

test('a typed library command naming a ticket is observed in the note with the branch and head', async ($, on) => {
  const ticket = '.scratch/demo/issues/01-t.md'
  const w = world(on, { files: { [`/r/${ticket}`]: BOLD_READY_TICKET }, git: git(repo()) })
  on('command.run', () => ({ text: '' }))
  await start($, w.clock)
  await typed($, 'mattpocock-skills:implement', ticket)
  await w.clock.advance(1000)
  const note = JSON.parse(w.written[`${W}/features/demo/note.json`] ?? '{}')
  expect(note.observed).toContainEqual(
    expect.objectContaining({
      skill: 'mattpocock-skills:implement',
      doc: ticket,
      branch: 'feat/auth',
      head: HEAD,
    }),
  )
})

test('agents running at a clear are counted until each has finished', async ($, on) => {
  const agents = [
    { id: 'a', status: 'running' },
    { id: 'b', status: 'failed' },
    { id: 'c', status: 'pending' },
  ]
  const w = world(on, { files: spWorld(complete(1)), git: git(repo()), agents })
  const file = `${W}/branches/feat%2Fauth/agents`
  await start($, w.clock)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await w.clock.advance(1000)
  expect(w.written[file]).toContain('2 agents')
  agents[0] = { id: 'a', status: 'completed' }
  agents[2] = { id: 'c', status: 'killed' }
  await $.turn.complete(turnDone('a'))
  await w.clock.advance(1000)
  expect(w.written[file]).toBe('')
})

test('an agent list the session denies leaves the hooks whole and the band drawn', async ($, on) => {
  const files = spWorld(complete(1))
  const w = world(on, { files, git: git(repo()) })
  below(on)
  await start($, w.clock)
  files[LEDGER] = ledger(complete(1), complete(2))
  await $.turn.complete(turnDone('a'))
  await w.clock.advance(1000)
  expect(w.calls).toContain('agent.list')
  expect(await band($)).toEqual(['whereami · auth · build 2/3', 'below'])
})

const TWO_TASK_PLAN = [
  '**Spec:** `docs/superpowers/specs/2026-10-05-auth-design.md`',
  '### Task 1: Add token store',
  '### Task 2: Persist the session',
].join('\n')

test('a skill start naming its document by absolute path before the first refresh ends picks one of two linked features until a clear, then the band asks again', async ($, on) => {
  const w = world(on, { files: { ...linked('a'), ...linked('b') }, git: git(repo()) })
  on('command.run', () => ({ text: '' }))
  below(on)
  // Typed while the start's refresh is still under way: no repo facts yet.
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  await typed($, 'superpowers:writing-plans', '/r/docs/superpowers/specs/2026-10-01-a-design.md')
  await w.clock.advance(1000)
  expect((await band($))[0]).toMatch(/^whereami · a · /)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await w.clock.advance(1000)
  expect(await band($)).toEqual([CHOOSE, 'below'])
})

test('a failed Edit still refreshes; a failed Skill, Edit or Read is evidence of nothing and keeps the window open', async ($, on) => {
  // A is not there, so its Edit and Read fail; no skill is installed, so the Skill call fails.
  const A = '/r/docs/superpowers/specs/2026-10-06-a-design.md'
  const B = '/r/docs/superpowers/specs/2026-10-06-b-design.md'
  const w = world(on, { files: { [B]: '# B\n' }, git: git(repo()) })
  on('command.run', () => ({ text: '' }))
  below(on)
  await start($, w.clock)
  const before = refreshes(w)
  // A failed Edit may have changed the file all the same: it refreshes.
  await $.tool.call({ tool: 'Edit', file_path: A, old_string: 'a', new_string: 'b' })
  await w.clock.advance(1000)
  expect(refreshes(w)).toBe(before + 1)
  await typed($, 'superpowers:brainstorming', '')
  await $.tool.call({ tool: 'Skill', skill: 'superpowers:writing-plans', args: A })
  await $.tool.call({ tool: 'Read', file_path: A })
  await $.tool.call({ tool: 'Read', file_path: B })
  await w.clock.advance(1000)
  expect(await band($)).toEqual(['whereami · b · design ?', 'below'])
})

test('a document a Bash call creates starts its feature with no other evidence of it; a folder named like one is none', async ($, on) => {
  const spec = '/r/.scratch/demo/spec.md'
  const ghost = '/r/docs/superpowers/specs/2026-10-06-ghost-design.md'
  const files: Record<string, string> = {}
  const mtimes: Record<string, number> = {}
  const w = world(on, { files, git: git(repo()), mtimes })
  below(on)
  await start($, w.clock)
  expect(await band($)).toEqual(['below'])
  files[spec] = '# Demo\n'
  files[`${ghost}/x`] = ''
  mtimes[spec] = w.clock.now()
  mtimes[ghost] = w.clock.now()
  await bash($)
  await w.clock.advance(1000)
  const note = JSON.parse(w.written[`${W}/features/demo/note.json`] ?? '{}')
  expect(note.docs).toEqual({ spec: '.scratch/demo/spec.md' })
  expect((await band($))[0]).toMatch(/^whereami · demo · /)
  expect(Object.keys(w.written).filter((p) => p.endsWith('/note.json'))).toEqual([
    `${W}/features/demo/note.json`,
  ])
})

test('a plan Bash writes after a Write of another plan for the same spec is the one followed', async ($, on) => {
  const spec = '/r/docs/superpowers/specs/2026-10-05-auth-design.md'
  const first = `/r/${PLAN}`
  const second = '/r/docs/superpowers/plans/2026-10-06-auth.md'
  const files: Record<string, string> = { [spec]: '# Auth\n' }
  const mtimes: Record<string, number> = {}
  const commands = ['superpowers:subagent-driven-development']
  const w = world(on, { files, git: git(repo()), mtimes, commands })
  below(on)
  await start($, w.clock)
  files[first] = THREE_TASK_PLAN
  mtimes[first] = w.clock.now()
  await $.tool.call({ tool: 'Write', file_path: first, content: THREE_TASK_PLAN })
  await w.clock.advance(1000)
  expect(await band($)).toEqual(['whereami · auth · plan 0/3', 'below'])
  files[second] = TWO_TASK_PLAN
  mtimes[second] = w.clock.now()
  await bash($)
  await w.clock.advance(1000)
  expect(await band($)).toEqual(['whereami · auth · plan 0/2', 'below'])
  expect(w.written[`${W}/branches/feat%2Fauth/detail`]).toContain(
    'next: /superpowers:subagent-driven-development docs/superpowers/plans/2026-10-06-auth.md',
  )
})

test('a denied discovery inspection reports unknown instead of persisting partial evidence', async ($, on) => {
  const A = '/r/.scratch/a/spec.md'
  const B = '/r/.scratch/b/spec.md'
  const files: Record<string, string> = {}
  const mtimes: Record<string, number> = {}
  const logged: string[] = []
  let deny = true
  on('fs.stat', { path: onPath(B) }, async (_, e, next) => {
    if (deny) return { deny: 'EACCES' }
    return next(e)
  })
  on('ui.log', (_, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  const w = world(on, { files, git: git(repo()), mtimes })
  below(on)
  await start($, w.clock)
  files[A] = '# A\n'
  files[B] = '# B\n'
  mtimes[A] = w.clock.now()
  mtimes[B] = w.clock.now()
  await bash($)
  await w.clock.advance(1000)
  expect(await band($)).toEqual(['whereami · ?', 'below'])
  expect(await band($, { bodyColumns: 9 })).toEqual(['whereami…', 'below'])
  expect(logged.join('\n')).toContain(`whereami: refresh failed: Error: not looked at: ${B}`)
  expect(Object.keys(w.written)).toEqual([])
  deny = false
  await bash($)
  await w.clock.advance(1000)
  expect(await band($)).toEqual([CHOOSE, 'below'])
})

for (const evidence of ['typed', 'read'] as const) {
  test(`an existing-worktree switch retains ${evidence} evidence before its delayed refresh`, async ($, on) => {
    const root = '/wt/existing tree'
    const doc = '.scratch/demo/spec.md'
    const r = repo()
    let cwd = '/r'
    const w = world(on, {
      files: {
        '/r/.git/HEAD': 'ref: refs/heads/feat/auth\n',
        [`${root}/${doc}`]: '# Demo\n',
      },
      cwd: () => cwd,
      git: (args) => {
        if (args.join(' ') === 'rev-parse --path-format=absolute --show-toplevel')
          return `${cwd === '/r' ? '/r' : root}\n`
        if (args.join(' ') === 'rev-parse --path-format=absolute --show-toplevel --git-common-dir')
          return `${cwd === '/r' ? '/r' : root}\n/r/.git\n`
        return git(r)(args)
      },
    })
    on('command.run', () => ({ text: '' }))
    below(on)
    await start($, w.clock)
    expect(await band($)).toEqual(['below'])
    cwd = `${root}/subdir`
    r.branch = 'feat/demo'
    await $.tool.call({ tool: 'EnterWorktree', name: 'existing' })
    const before = refreshes(w)
    await typed($, 'mattpocock-skills:grill-me', evidence === 'typed' ? `"${root}/${doc}"` : '')
    if (evidence === 'read') await $.tool.call({ tool: 'Read', file_path: `${root}/${doc}` })
    expect(refreshes(w)).toBe(before)
    expect(Object.keys(w.written)).toEqual([])
    await w.clock.advance(1000)
    const note = JSON.parse(w.written[`${W}/features/demo/note.json`] ?? '{}')
    expect(note.docs).toEqual({ spec: doc })
    expect(note.branches).toEqual(['feat/demo'])
    if (evidence === 'typed')
      expect(note.observed).toContainEqual(
        expect.objectContaining({ skill: 'mattpocock-skills:grill-me', doc }),
      )
    expect(w.written[`${W}/branches/feat%2Fdemo/feature`]).toBe('demo\n')
    expect((await band($))[0]).toMatch(/^whereami · demo · design/)
  })
}
