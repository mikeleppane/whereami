import type { On } from 'claude-code'
import { type Engine, expect, type MockClock, test } from 'claude-code/testing'
import { BOLD_READY_TICKET } from './fixtures/matt'
import { complete, git, LEDGER, ledger, PLAN, repo, spWorld } from './fixtures/repo'
import { bash, below, CHOOSE, linked, NOW, onPath, refreshes, TOP, W, world } from './world'

const BUILD = 'superpowers:subagent-driven-development'
const COMMAND = `/${BUILD} ${PLAN}`
const SPEC = 'docs/superpowers/specs/2026-10-05-auth-design.md'
const SURFACES = ['terminal', 'desktop'] as const
const SCRATCH = '.scratch/demo'
const TICKET = `${SCRATCH}/issues/01-t.md`

const PANE = {
  plugin: 'whereami',
  component: 'Pane',
  requestId: 'whereami',
  props: {
    title: 'whereami',
    isFocused: true,
    bodyColumns: 80,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'whereami',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 3,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const

// A Superpowers build of auth on feat/auth, task 1 of 3 done, the build skill installed unless `commands` says
// otherwise; the session has started and its refresh has run.
async function started(
  $: Engine,
  on: On,
  opts: {
    prompt?: string
    commands?: string[]
    files?: Record<string, string>
    mtimes?: Record<string, number>
  } = {},
) {
  const w = world(on, {
    files: opts.files ?? spWorld(complete(1)),
    git: git(repo()),
    commands: opts.commands ?? [BUILD],
    ...(opts.mtimes === undefined ? {} : { mtimes: opts.mtimes }),
    ...(opts.prompt === undefined ? {} : { prompt: opts.prompt }),
  })
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  return w
}

// The pane on `surface`: its lines, its buttons (key and label), and a press by key.
async function pane($: Engine, surface: (typeof SURFACES)[number]) {
  const ui = await $.ui.mount({ ...PANE, surface })
  const lines = async () => (await ui.findAll({ type: 'Text' })).map((t) => t.text)
  const buttons = async () =>
    (await ui.findAll({ type: 'Button' })).map((b) => [b.key, b.props.label])
  return { ui, lines, buttons, press: (key: string) => ui.press({ key }) }
}

const band = async ($: Engine) => {
  const ui = await $.ui.mount(BAND)
  const lines = (await ui.findAll({ type: 'Text' })).map((t) => t.text)
  await ui.unmount()
  return lines
}

const request = ($: Engine, args: string) =>
  $.command.run({
    command: 'whereami',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

const typed = async ($: Engine, args: string, clock: MockClock) => {
  const answer = request($, args)
  await clock.advance(1000)
  return answer
}

const note = (written: Record<string, string>, id: string, where = W) =>
  JSON.parse(written[`${where}/features/${id}/note.json`] ?? '{}')

// Writes to `path` beneath whereami: `deny` refuses them; `hold` keeps the next one waiting until `release`.
const gate = (on: On, path: string) => {
  const g = { deny: false, hold: false, release: () => {} }
  const held = new Promise<void>((r) => {
    g.release = r
  })
  on('fs.write', { path: onPath(path) }, async (_, e, next) => {
    if (g.deny) return { deny: 'refused' }
    if (g.hold) {
      g.hold = false
      await held
    }
    return next(e)
  })
  return g
}

// The two ways to forget, each answering with the line the user reads.
const FORGET = {
  command: async ($: Engine, clock: MockClock) => (await typed($, 'forget', clock)).text,
  button: async ($: Engine) => {
    const p = await pane($, 'terminal')
    await p.press('forget')
    const [first] = await p.lines()
    await p.ui.unmount()
    return first
  },
}

// Every copy the surface was asked for, with the surface it was asked on.
const copies = (on: On) => {
  const seen: string[] = []
  on('ui.copy', { text: COMMAND }, (_, e, next) => {
    seen.push(`${e.surface} ${e.text}`)
    return next(e)
  })
  return seen
}

test('Draft fills an empty prompt box with the command and copies nothing', async ($, on) => {
  const w = await started($, on)
  for (const surface of SURFACES) {
    const p = await pane($, surface)
    const before = w.calls.length
    await p.press('draft')
    const calls = w.calls.slice(before)
    // Appended to the box read as empty: a key typed since the read is never overwritten.
    expect(calls).toContain(`prompt.fill append ${COMMAND}`)
    expect(calls.filter((c) => c.startsWith('ui.copy'))).toEqual([])
    await p.ui.unmount()
  }
})

for (const prompt of ['draft test', '   '])
  test(`Draft leaves a prompt box holding ${JSON.stringify(prompt)} alone and copies the command on the pressed surface`, async ($, on) => {
    const seen = copies(on)
    const w = await started($, on, { prompt })
    for (const surface of SURFACES) {
      const p = await pane($, surface)
      const before = w.calls.length
      await p.press('draft')
      const calls = w.calls.slice(before)
      expect(calls).toContain('prompt.read')
      expect(calls.filter((c) => c.startsWith('prompt.fill'))).toEqual([])
      expect(seen.at(-1)).toBe(`${surface} ${COMMAND}`)
      expect(await p.lines()).toContain('your prompt has text, so the command was copied instead')
      await p.ui.unmount()
    }
  })

// A hook's refusal carries no reason, so its cause is unknown: not "no prompt box" (that is `no_composer`).
test('a fill refused with no reason copies the command instead and says why', async ($, on) => {
  const seen = copies(on)
  on('prompt.fill', { text: COMMAND }, () => ({ isFilled: false }))
  await started($, on)
  for (const surface of SURFACES) {
    const p = await pane($, surface)
    await p.press('draft')
    expect(seen.at(-1)).toBe(`${surface} ${COMMAND}`)
    expect(await p.lines()).toContain('copied: the prompt box did not take the command')
    await p.ui.unmount()
  }
})

test('a refused copy shows the command to copy by hand', async ($, on) => {
  on('ui.copy', { text: COMMAND }, () => ({ value: { isCopied: false, reason: 'no-clipboard' } }))
  await started($, on, { prompt: 'draft test' })
  for (const surface of SURFACES) {
    const p = await pane($, surface)
    await p.press('draft')
    expect(await p.lines()).toContain(`copy this command: ${COMMAND}`)
    await p.ui.unmount()
  }
})

for (const [way, said] of [
  ['command', 'whereami: forgot auth'],
  ['button', 'forgot auth'],
] as const)
  for (const record of ['valid', 'missing', 'corrupt', 'omitted-docs', 'plan-only'] as const)
    test(`forgetting by ${way} survives a ${record} note on later refreshes`, async ($, on) => {
      below(on)
      const files: Record<string, string> = {
        ...spWorld(complete(1)),
        [`/r/${SPEC}`]: '# Auth\n',
      }
      const path = `${W}/features/auth/note.json`
      const w = await started($, on, { files, mtimes: { [`/r/${SPEC}`]: NOW } })
      expect(await band($)).toEqual(['whereami · auth · build 1/3', 'below'])
      expect(await FORGET[way]($, w.clock)).toBe(said)
      expect(w.written[`${W}/features/auth/forget`]).toMatch(/^[^\n]+\n$/)
      const marker = JSON.parse(w.written[`${W}/features/auth/forget`] ?? '{}')
      expect({ ...marker, documents: marker.documents?.sort() }).toEqual({
        version: 1,
        id: 'auth',
        documents: [PLAN, SPEC],
      })
      expect(await band($)).toEqual(['below'])
      if (record === 'missing') delete files[path]
      if (record === 'corrupt') files[path] = '{"version":'
      if (record === 'omitted-docs') files[path] = '{"version":1,"id":"auth"}'
      if (record === 'plan-only')
        files[path] = JSON.stringify({ ...note(w.written, 'auth'), docs: { plan: PLAN } })
      delete w.written[path]
      const before = refreshes(w)
      for (let count = 1; count <= 2; count++) {
        await bash($)
        await w.clock.advance(1000)
        expect(refreshes(w) - before).toBe(count)
        expect(await band($)).toEqual(['below'])
        expect(Object.keys(w.written).filter((p) => p.endsWith('/note.json'))).toEqual([])
      }
      expect(await typed($, '', w.clock)).toEqual({
        text: 'whereami: nothing to show here',
      })
      expect(refreshes(w) - before).toBe(3)
      expect(await band($)).toEqual(['below'])
      expect(w.written[path]).toBeUndefined()
      expect(Object.keys(w.written).filter((p) => p.endsWith('/note.json'))).toEqual([])
    })

for (const way of ['command', 'button'] as const)
  test(`a forget marker the ${way} cannot write says so and keeps the feature`, async ($, on) => {
    below(on)
    const g = gate(on, `${W}/features/auth/forget`)
    const w = await started($, on)
    g.deny = true
    expect(await FORGET[way]($, w.clock)).toBe(
      way === 'command'
        ? 'whereami: could not forget auth'
        : `not done: not written: ${W}/features/auth/forget`,
    )
    expect(await band($)).toEqual(['whereami · auth · build 1/3', 'below'])
  })

test('Not this feature takes the branch out of the note and records it as unlinked', async ($, on) => {
  const w = await started($, on)
  expect(note(w.written, 'auth').branches).toEqual(['feat/auth'])
  const p = await pane($, 'terminal')
  await p.press('unlink')
  await w.clock.advance(1000)
  const after = note(w.written, 'auth')
  expect(after.branches).toEqual([])
  expect(after.unlinked).toEqual(['feat/auth'])
  expect(w.written[`${W}/features/auth/branches`]).toBe('\n')
})

test('two candidates each get a This is button with their reasons and no Draft; choosing one links only it', async ($, on) => {
  below(on)
  const w = await started($, on, { files: { ...linked('a'), ...linked('b') } })
  for (const surface of SURFACES) {
    const p = await pane($, surface)
    expect(await p.buttons()).toEqual([
      ['choose:a', 'This is a'],
      ['choose:b', 'This is b'],
    ])
    const lines = await p.lines()
    expect(lines).toContain('a: branch already linked')
    expect(lines).toContain('b: branch already linked')
    await p.ui.unmount()
  }
  const p = await pane($, 'terminal')
  await p.press('choose:b')
  await w.clock.advance(1000)
  expect(note(w.written, 'a').branches).toEqual([])
  expect(note(w.written, 'b').branches).toEqual(['feat/auth'])
  expect(await band($)).toEqual(['whereami · b · design', 'below'])
})

for (const move of ['branch', 'repository', 'detached worktree'] as const)
  test(`a mounted choice stays in its original context after a ${move} switch`, async ($, on) => {
    below(on)
    const a = 'docs/superpowers/specs/2026-10-01-a-design.md'
    const b = 'docs/superpowers/specs/2026-10-01-b-design.md'
    const originalBranch = move === 'detached worktree' ? null : 'feat/a'
    const r = repo({ branch: originalBranch })
    let root = '/r'
    let commonDir = '/r/.git'
    const saved = { ...linked('a', ['feat/a']), ...linked('b', ['feat/a', 'feat/b']) }
    const files: Record<string, string> = {
      ...saved,
      [`/r/${a}`]: '# A\n',
      [`/r/${b}`]: '# B\n',
    }
    const mtimes: Record<string, number> = { [`/r/${a}`]: NOW, [`/r/${b}`]: NOW }
    const answer = git(r)
    const w = world(on, {
      files,
      mtimes,
      cwd: () => root,
      git: (args) => {
        const command = args.join(' ')
        if (command === 'rev-parse --path-format=absolute --show-toplevel --git-common-dir')
          return `${root}\n${commonDir}\n`
        if (command === 'rev-parse --path-format=absolute --show-toplevel') return `${root}\n`
        return answer(args)
      },
    })
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    await w.clock.settle()
    const p = await pane($, 'terminal')
    expect(await p.buttons()).toEqual([
      ['choose:a', 'This is a'],
      ['choose:b', 'This is b'],
    ])
    await $.tool.call({ tool: 'Edit', file_path: `/r/${a}`, old_string: 'A', new_string: 'A2' })
    await w.clock.advance(1000)
    await p.press('choose:a')
    await w.clock.advance(1000)
    expect(await band($)).toEqual([
      move === 'detached worktree'
        ? 'whereami · a · detached HEAD · design'
        : 'whereami · a · design',
      'below',
    ])
    expect(note(w.written, 'a').branches).toEqual(['feat/a'])

    if (move === 'branch') r.branch = 'feat/b'
    if (move === 'repository') {
      commonDir = '/r/other.git'
      for (const [path, text] of Object.entries(saved))
        files[path.replace('/r/.git', commonDir)] = text
    }
    if (move === 'detached worktree') {
      root = '/wt/other tree'
      files[`${root}/${a}`] = '# A\n'
      files[`${root}/${b}`] = '# B\n'
      mtimes[`${root}/${a}`] = NOW
      mtimes[`${root}/${b}`] = NOW
    }
    files[`${root}/${PLAN}`] = `**Spec:** \`${b}\`\n### Task 1: First\n### Task 2: Second\n`
    files[`${root}/.superpowers/sdd/b/plan-path`] = `${PLAN}\n`
    files[`${root}/.superpowers/sdd/b/progress.md`] = ledger(complete(1))
    await bash($)
    await w.clock.advance(1000)
    expect(await band($)).toEqual([
      move === 'detached worktree'
        ? 'whereami · b · detached HEAD · build 1/2'
        : 'whereami · b · build 1/2',
      'below',
    ])
    const where = `${commonDir}/whereami`
    expect(note(files, 'a', where).branches).toEqual(['feat/a'])
    expect(note(w.written, 'b', where).branches).toEqual(
      move === 'branch' ? ['feat/b'] : ['feat/a', 'feat/b'],
    )
    const key =
      move === 'detached worktree'
        ? 'detached-%2Fwt%2Fother%20tree'
        : move === 'branch'
          ? 'feat%2Fb'
          : 'feat%2Fa'
    expect(w.written[`${where}/branches/${key}/feature`]).toBe('b\n')
    for (const file of ['message', 'context']) {
      const text = JSON.parse(`"${w.written[`${where}/branches/${key}/${file}`]?.split('\n')[0]}"`)
      expect(text).toContain('whereami · b ·')
      expect(text).toContain('build 1/2')
    }
    expect(await p.lines()).toContain(`plan: ${PLAN}`)

    root = '/r'
    commonDir = '/r/.git'
    r.branch = originalBranch
    await bash($)
    await w.clock.advance(1000)
    expect(await band($)).toEqual([
      move === 'detached worktree'
        ? 'whereami · a · detached HEAD · design'
        : 'whereami · a · design',
      'below',
    ])
    expect(note(w.written, 'a').branches).toEqual(['feat/a'])
    await p.ui.unmount()
  })

// A rival's note.json written without the branch (its branches file refused) leaves only b linked.
for (const [name, saved] of [
  ['note.json', CHOOSE],
  ['branches', 'whereami · b · design'],
] as const)
  test(`choosing b when its rival's ${name} cannot be written says so; later refreshes show only what was saved`, async ($, on) => {
    below(on)
    const g = gate(on, `${W}/features/a/${name}`)
    const w = await started($, on, { files: { ...linked('a'), ...linked('b') } })
    g.deny = true
    const p = await pane($, 'terminal')
    await p.press('choose:b')
    expect((await p.lines())[0]).toBe(`not done: not written: ${W}/features/a/${name}`)
    expect(await band($)).toEqual([CHOOSE, 'below'])
    await bash($)
    await w.clock.advance(1000)
    expect(await band($)).toEqual([saved, 'below'])
  })

test('This is <old> after a switch shows the finished feature and keeps the branch on it alone', async ($, on) => {
  below(on)
  const files: Record<string, string> = {
    ...spWorld(complete(1)),
    ...linked('old'),
    [`${W}/features/old/finished`]: '1700000000\n',
  }
  const w = await started($, on, { files })
  const p = await pane($, 'terminal')
  expect(await p.lines()).toContain('switched to auth; old is done')
  await p.press('choose:old')
  await w.clock.advance(1000)
  expect(note(w.written, 'old').branches).toEqual(['feat/auth'])
  expect(note(w.written, 'auth').branches).toEqual([])
  expect(await band($)).toEqual(['whereami · old · design', 'below'])
  await bash($)
  await w.clock.advance(1000)
  expect(await band($)).toEqual(['whereami · old · design', 'below'])
  expect(note(w.written, 'auth').branches).toEqual([])
  delete files[LEDGER]
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect(note(w.written, 'old').branches).toEqual(['feat/auth'])
  files[LEDGER] = ledger(complete(1), complete(2))
  await w.clock.advance(1000)
  expect(await band($)).toEqual(['whereami · auth · build 2/3', 'below'])
})

for (const reset of ['clear', 'start'] as const)
  for (const pending of ['queued', 'writing'] as const)
    test(`a ${pending} choice from before session ${reset} cannot override new recorded evidence`, async ($, on) => {
      below(on)
      const authLinks: string[][] = []
      on('fs.write', { path: onPath(`${W}/features/auth/note.json`) }, async (_, e, next) => {
        const result = await next(e)
        authLinks.push(JSON.parse(e.text).branches)
        return result
      })
      const g = gate(
        on,
        `${W}/features/${pending === 'queued' ? 'auth/note.json' : 'old/finished'}`,
      )
      const files: Record<string, string> = {
        ...spWorld(complete(1)),
        ...linked('old'),
        [`${W}/features/old/finished`]: '1700000000\n',
      }
      const w = await started($, on, { files })
      const p = await pane($, 'terminal')
      expect(await p.lines()).toContain('switched to auth; old is done')
      g.hold = true
      if (pending === 'queued') {
        await bash($)
        await w.clock.advance(1000)
      }
      await p.press('choose:old')
      await w.clock.advance(1000)
      expect(g.hold).toBe(false)
      if (pending === 'writing') expect(note(w.written, 'auth').branches).toEqual([])
      if (reset === 'clear')
        await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
      else await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
      expect(note(files, 'old').branches).toEqual(['feat/auth'])
      files[LEDGER] = ledger(complete(1), complete(2))
      g.release()
      await w.clock.advance(1000)
      expect(await band($)).toEqual(['whereami · auth · build 2/3', 'below'])
      expect((await typed($, '', w.clock)).text).toContain('auth · build 2/3')
      expect(note(files, 'old').branches).toEqual(['feat/auth'])
      if (pending === 'queued')
        expect(authLinks.filter((branches) => !branches.includes('feat/auth'))).toEqual([])
      await p.ui.unmount()
    })

test('a press waits for the refresh writing under way, so its change is not written over', async ($, on) => {
  const g = gate(on, `${W}/features/auth/note.json`)
  const files = spWorld(complete(1))
  const w = await started($, on, { files })
  files[LEDGER] = ledger(complete(1), complete(2))
  g.hold = true
  await bash($)
  await w.clock.advance(1000)
  const p = await pane($, 'terminal')
  await p.press('unlink')
  g.release()
  await w.clock.advance(1000)
  expect(note(w.written, 'auth').unlinked).toEqual(['feat/auth'])
  expect(note(w.written, 'auth').last.tasks['2'].state).toBe('complete')
})

test('a scheduled refresh coming due during /whereami runs after it, never beside it', async ($, on) => {
  const g = gate(on, `${W}/features/auth/note.json`)
  const w = await started($, on)
  g.hold = true
  const answer = request($, '')
  await w.clock.advance(1000)
  await bash($)
  const before = refreshes(w)
  await w.clock.advance(1000)
  expect(refreshes(w)).toBe(before)
  g.release()
  expect((await answer).text).toContain('build 1/3')
  await w.clock.settle()
  expect(refreshes(w) - before).toBe(1)
})

test('commands, presses and scheduled requests start refreshes at least 1000 ms apart', async ($, on) => {
  const starts: number[] = []
  const answer = git(repo())
  const w = world(on, {
    files: spWorld(complete(1)),
    git: (args) => {
      if (`process.run git ${args.join(' ')}` === TOP) starts.push(w.clock.now())
      return answer(args)
    },
  })
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  const first = request($, '')
  const second = request($, '')
  await w.clock.settle()
  expect(starts.map((t) => t - NOW)).toEqual([0])
  await w.clock.advance(999)
  expect(starts.map((t) => t - NOW)).toEqual([0])
  await w.clock.advance(1)
  expect((await first).text).toContain('build 1/3')
  await w.clock.advance(1000)
  expect((await second).text).toContain('build 1/3')
  const p = await pane($, 'terminal')
  await p.press('unlink')
  await bash($)
  await bash($)
  await w.clock.advance(999)
  expect(starts.map((t) => t - NOW)).toEqual([0, 1000, 2000])
  await w.clock.advance(1)
  expect(note(w.written, 'auth').unlinked).toEqual(['feat/auth'])
  await w.clock.advance(1000)
  expect(starts.map((t) => t - NOW)).toEqual([0, 1000, 2000, 3000, 4000])
  await w.clock.advance(2000)
  expect(starts.map((t) => t - NOW)).toEqual([0, 1000, 2000, 3000, 4000])
})

test('/whereami forget reports a failed refresh when branches cannot be written', async ($, on) => {
  below(on)
  const g = gate(on, `${W}/features/auth/branches`)
  const w = await started($, on)
  g.deny = true
  expect((await typed($, 'forget', w.clock)).text).toBe('whereami: refresh failed')
  expect(await band($)).toEqual(['whereami · ?', 'below'])
  const p = await pane($, 'terminal')
  expect((await p.lines())[0]).toContain('refresh failed')
  expect(w.written[`${W}/features/auth/forget`]).toBeUndefined()
  g.deny = false
  expect((await typed($, '', w.clock)).text).toContain('build 1/3')
})

for (const name of ['note.json', 'branches'] as const)
  test(`choosing a new candidate whose ${name} write is refused never publishes the unsaved pick`, async ($, on) => {
    below(on)
    const g = gate(on, `${W}/features/b/${name}`)
    const a = '/r/.scratch/a/spec.md'
    const b = '/r/.scratch/b/spec.md'
    const w = world(on, {
      files: { [a]: '# A', [b]: '# B' },
      mtimes: { [a]: NOW, [b]: NOW },
      git: git(repo()),
    })
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    await w.clock.settle()
    expect(await band($)).toEqual([CHOOSE, 'below'])
    const p = await pane($, 'terminal')
    g.deny = true
    await p.press('choose:b')
    await w.clock.advance(1000)
    expect((await p.lines())[0]).toContain('not done:')
    expect(await band($)).toEqual(['whereami · ?', 'below'])
    g.deny = false
    await bash($)
    await w.clock.advance(1000)
    expect(await band($)).toEqual([CHOOSE, 'below'])
    await p.press('choose:a')
    await w.clock.advance(1000)
    expect(note(w.written, 'a').branches).toEqual(['feat/auth'])
    expect((await band($))[0]).toMatch(/^whereami · a · design/)
  })

test('a queued draft, unlink or forget from auth cannot act on the feature replacing it during held IO', async ($, on) => {
  below(on)
  const g = gate(on, `${W}/features/beta/note.json`)
  const files = spWorld(complete(1))
  const w = await started($, on, { files })
  const p = await pane($, 'terminal')
  expect((await p.lines())[0]).toBe('whereami · auth · build 1/3')
  const plan = 'docs/superpowers/plans/2026-10-06-beta.md'
  files[`/r/${plan}`] = '### Task 1: Beta\n'
  files['/r/.superpowers/sdd/beta/plan-path'] = `${plan}\n`
  files['/r/.superpowers/sdd/beta/progress.md'] = `# SDD ledger — plan: ${plan}\n`
  delete files[LEDGER]
  delete files['/r/.superpowers/sdd/auth/plan-path']
  g.hold = true
  await bash($)
  await w.clock.advance(1000)
  const before = w.calls.length
  for (const action of ['draft', 'unlink', 'forget']) await p.press(action)
  g.release()
  await w.clock.advance(1000)
  expect((await p.lines())[0]).toContain('stale action')
  expect((await band($))[0]).toMatch(/^whereami · beta · build/)
  expect(note(w.written, 'beta').branches).toEqual(['feat/auth'])
  expect(note(w.written, 'beta').unlinked).toEqual([])
  expect(w.written[`${W}/features/beta/forget`]).toBeUndefined()
  expect(w.calls.slice(before).filter((c) => /^(prompt\.|ui.copy)/.test(c))).toEqual([])
})

test('/whereami answers ids, paths, counts and statuses; ledger text shows in the pane only', async ($, on) => {
  const files = spWorld(complete(1), 'Task 2: SECRET-FINDING', 'SECRET-NOTE')
  const w = await started($, on, { files })
  const { text } = await typed($, '', w.clock)
  expect(w.calls).toContain('ui.open whereami')
  expect(text).toContain('build 1/3')
  expect(text).toContain(PLAN)
  expect(text).not.toContain('SECRET')
  const lines = await (await pane($, 'terminal')).lines()
  expect(lines).toContain('finding: Task 2: SECRET-FINDING')
  expect(lines).toContain('note: SECRET-NOTE')
})

// Spec sections 2 and 7: each status names its evidence, a ledger path:line or a ticket path.
for (const [kind, opts, row] of [
  [
    'ledger line',
    {},
    'Task 1 Add token store · complete · reviewed · recorded: commits a..b, review clean (.superpowers/sdd/auth/progress.md:2)',
  ],
  [
    'ticket path',
    {
      files: { [`/r/${SCRATCH}/spec.md`]: '# S', [`/r/${TICKET}`]: BOLD_READY_TICKET },
      mtimes: { [`/r/${SCRATCH}/spec.md`]: NOW },
    },
    `01 Add token store · open · recorded: Status: ready-for-agent (${TICKET})`,
  ],
] as const)
  test(`each status in the pane names its evidence: ${kind}`, async ($, on) => {
    await started($, on, opts)
    for (const surface of SURFACES) {
      const p = await pane($, surface)
      expect(await p.lines()).toContain(row)
      await p.ui.unmount()
    }
  })

// Spec section 5: a squash merge leaves no trace, so the pane says merged is unknown, never "not merged".
test('after a squash merge the pane says merged is unknown', async ($, on) => {
  const files = spWorld(complete(1), complete(2), complete(3))
  const r = repo({ log: `\0${'d'.repeat(40)}\tplan\0\n${PLAN}\0` })
  const w = world(on, { files, git: git(r) })
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  delete files[LEDGER]
  Object.assign(r, { deleted: true, branch: null })
  await bash($)
  await w.clock.advance(1000)
  for (const surface of SURFACES) {
    const p = await pane($, surface)
    const lines = await p.lines()
    expect(lines[0]).toBe('whereami · auth · detached HEAD · done 3/3')
    expect(lines).toContain('merged: unknown')
    await p.ui.unmount()
  }
})

for (const [damage, body, diagnostic] of [
  ['invalid header', 'SECRET-HEADER', 'not a Superpowers ledger'],
  ['oversized ledger', 'x'.repeat(1048577), 'file over 1 MB or not text'],
  ['binary ledger', 'a\0b', 'file over 1 MB or not text'],
] as const)
  test(`an already-linked feature shows its ${damage} diagnostic in the pane only`, async ($, on) => {
    const files = spWorld(complete(1))
    const w = await started($, on, { files })
    expect(note(w.written, 'auth').branches).toEqual(['feat/auth'])
    files[LEDGER] = body
    const { text } = await typed($, '', w.clock)
    expect(text).toContain(PLAN)
    expect(text).not.toContain('SECRET')
    expect(text).not.toContain(diagnostic)
    for (const surface of SURFACES) {
      const p = await pane($, surface)
      expect((await p.lines()).join('\n')).toContain(`unsupported format: ${diagnostic}`)
      await p.ui.unmount()
    }
  })

test('a build skill not installed is named and nothing can be drafted', async ($, on) => {
  await started($, on, { commands: [] })
  for (const surface of SURFACES) {
    const p = await pane($, surface)
    expect((await p.lines()).join('\n')).toContain(`(not installed: ${BUILD})`)
    expect(await p.buttons()).toEqual([
      ['unlink', 'Not this feature'],
      ['forget', 'Forget'],
    ])
    await p.ui.unmount()
  }
})
