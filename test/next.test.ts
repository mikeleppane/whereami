import { expect, test } from 'claude-code/testing'
import type { MattResult } from '../src/matt'
import { readMatt } from '../src/matt'
import type { FeatureState } from '../src/next'
import { nextAction, phaseOf } from '../src/next'
import type { SpResult } from '../src/superpowers'
import type { ItemStatus, Phase } from '../src/types'

const PLAN = 'docs/superpowers/plans/2026-10-05-demo.md'
const SPEC = 'docs/superpowers/specs/2026-10-05-demo-design.md'
const MATT_SPEC = '.scratch/demo/spec.md'
const MAP = '.scratch/demo/map.md'

const feature = (overrides: Partial<FeatureState> = {}): FeatureState => ({
  id: 'demo',
  sp: null,
  matt: null,
  merged: 'n/a',
  agentsRunning: 0,
  agentsBeforeClear: 0,
  taskCommitsWithoutLedger: [],
  ...overrides,
})

const superpowers = (phase: Phase, overrides: Partial<SpResult> = {}): SpResult => ({
  library: 'superpowers',
  docs: { plan: PLAN },
  items: [],
  total: 0,
  phase,
  weak: false,
  notes: [],
  allComplete: false,
  ledgerSeen: false,
  currentLedger: false,
  ...overrides,
})

const mattResult = (phase: Phase, overrides: Partial<MattResult> = {}): MattResult => ({
  library: 'matt',
  docs: {},
  items: [],
  total: 0,
  phase,
  weak: false,
  notes: [],
  frontier: [],
  unreadableTickets: 0,
  ...overrides,
})

const item = (
  key: string,
  state: ItemStatus['state'],
  overrides: Partial<ItemStatus> = {},
): ItemStatus => ({
  key,
  title: key,
  kind: 'ticket',
  state,
  evidence: [],
  ...overrides,
})

const installed = (...commands: string[]) => new Set(commands)

test('agents from before clear take precedence and are told to wait', () => {
  const action = nextAction(
    feature({ sp: superpowers('plan'), agentsBeforeClear: 2 }),
    installed('superpowers:subagent-driven-development'),
  )

  expect(action?.command).toBe(undefined)
  expect(action?.text).toContain('wait: 2 agents from before the clear are still running')
})

test('task commits without a ledger block rebuilding the Superpowers plan', () => {
  const action = nextAction(
    feature({
      sp: superpowers('build'),
      taskCommitsWithoutLedger: [3, 1],
    }),
    installed('superpowers:subagent-driven-development'),
  )

  expect(action?.command).toBe(undefined)
  expect(action?.text).toContain(
    'commits for Task 1–3 found but no progress file: check before rebuilding',
  )
})

test('an idle implement-spec run asks for its integration branch before rerunning', () => {
  const action = nextAction(
    feature({
      matt: mattResult('build'),
      implementSpecAt: '2026-10-05T09:02:00',
    }),
    installed('mattpocock-skills:implement'),
  )

  expect(action?.command).toBe(undefined)
  expect(action?.text).toContain(
    'implement-spec started at 09:02 and nothing is running: check its integration branch before rerunning',
  )
})

test('a finished Superpowers feature without a ledger is not offered another build', () => {
  const action = nextAction(
    feature({
      sp: superpowers('done', { allComplete: true }),
      merged: false,
    }),
    installed(
      'superpowers:finishing-a-development-branch',
      'superpowers:subagent-driven-development',
    ),
  )

  expect(action?.command).toBe('/superpowers:finishing-a-development-branch')
  expect(action?.text).toContain('finish and merge this branch')
})

test('a Superpowers review resumes its configured build skill at the final review', () => {
  const action = nextAction(
    feature({
      sp: superpowers('review', { ledgerSeen: true }),
      buildSkill: 'superpowers:executing-plans',
    }),
    installed('superpowers:executing-plans'),
  )

  expect(action?.command).toBe(`/superpowers:executing-plans ${PLAN}`)
  expect(action?.text).toContain('resume: it continues at the final review')
})

test('a ledger-backed Superpowers build resumes from the progress file', () => {
  const action = nextAction(
    feature({ sp: superpowers('build', { ledgerSeen: true }) }),
    installed('superpowers:subagent-driven-development'),
  )

  expect(action?.command).toBe(`/superpowers:subagent-driven-development ${PLAN}`)
  expect(action?.text).toContain('resume: it continues from the progress file')
})

test('an idle Superpowers build or review is not resumed while agents are running', () => {
  const commands = installed('superpowers:subagent-driven-development')
  const runningReview = feature({
    sp: superpowers('review', { ledgerSeen: true }),
    agentsRunning: 1,
  })
  const runningBuild = feature({
    sp: superpowers('build', { ledgerSeen: true }),
    agentsRunning: 1,
  })

  expect(
    nextAction(feature({ sp: superpowers('review', { ledgerSeen: true }) }), commands)?.command,
  ).toBe(`/superpowers:subagent-driven-development ${PLAN}`)
  expect(
    nextAction(feature({ sp: superpowers('build', { ledgerSeen: true }) }), commands)?.command,
  ).toBe(`/superpowers:subagent-driven-development ${PLAN}`)
  expect(nextAction(runningReview, commands)).toBe(null)
  expect(nextAction(runningBuild, commands)).toBe(null)
})

test('a Superpowers plan starts subagent-driven development', () => {
  const action = nextAction(
    feature({ sp: superpowers('plan') }),
    installed('superpowers:subagent-driven-development'),
  )

  expect(action?.command).toBe(`/superpowers:subagent-driven-development ${PLAN}`)
  expect(action?.text).toContain('build the plan')
})

test('a Superpowers spec starts writing-plans', () => {
  const action = nextAction(
    feature({ sp: superpowers('design', { docs: { spec: SPEC } }) }),
    installed('superpowers:writing-plans'),
  )

  expect(action?.command).toBe(`/superpowers:writing-plans ${SPEC}`)
  expect(action?.text).toContain('turn the spec into a plan')
})

test('an unavailable Superpowers command is named without drafting it', () => {
  const action = nextAction(
    feature({ sp: superpowers('design', { docs: { spec: SPEC } }) }),
    installed(),
  )

  expect(action?.command).toBe(undefined)
  expect(action?.missing).toBe('superpowers:writing-plans')
  expect(action?.text).toContain('turn the spec into a plan')
})

test('a Matt spec without build tickets starts to-tickets despite an existing map', () => {
  const matt = readMatt({
    folder: '.scratch/demo',
    hasSpec: true,
    hasMap: true,
    tickets: [
      {
        key: '01',
        slug: 'prototype',
        title: 'Prototype decision',
        path: '.scratch/demo/issues/01-prototype.md',
        status: 'resolved',
        blockedBy: [],
        type: 'prototype',
      },
    ],
    unreadable: [],
    observed: [],
    relatedKeys: [],
  })
  const action = nextAction(
    feature({ matt }),
    installed('mattpocock-skills:to-tickets', 'mattpocock-skills:ask-matt'),
  )

  expect(action?.command).toBe(`/mattpocock-skills:to-tickets ${MATT_SPEC}`)
  expect(action?.text).toContain('turn the spec into tickets')
})

test('an unreadable ticket prevents to-tickets and explains the uncertainty', () => {
  const matt = readMatt({
    folder: '.scratch/demo',
    hasSpec: true,
    hasMap: true,
    tickets: [],
    unreadable: [{ path: '.scratch/demo/issues/01-build.md', why: 'file over 1 MB' }],
    observed: [],
    relatedKeys: [],
  })
  const action = nextAction(
    feature({ matt }),
    installed('mattpocock-skills:to-tickets', 'mattpocock-skills:ask-matt'),
  )

  expect(action?.command).toBe(undefined)
  expect(action?.text).toContain('cannot determine the next action: a ticket could not be read')
})

test('a Matt map with ready decisions starts wayfinder', () => {
  const action = nextAction(
    feature({
      matt: mattResult('design', {
        docs: { map: MAP },
        items: [item('01', 'open', { kind: 'decision', type: 'prototype' })],
        frontier: ['01'],
        decisions: [1, 3],
      }),
    }),
    installed('mattpocock-skills:wayfinder'),
  )

  expect(action?.command).toBe(`/mattpocock-skills:wayfinder ${MAP}`)
  expect(action?.text).toContain('resolve the ready decisions')
})

test('Matt implements the next open ticket and names tickets built here but still open', () => {
  const action = nextAction(
    feature({
      matt: mattResult('build', {
        docs: { tickets: '.scratch/demo/issues/' },
        items: [
          item('01', 'complete', {
            path: '.scratch/demo/issues/01-t.md',
            raw: 'ready-for-agent',
            evidence: [
              {
                strength: 'observed',
                source: 'seen 14:00',
                text: 'built here at 14:00, 2 commits, ticket still open',
              },
            ],
          }),
          item('02', 'open', {
            path: '.scratch/demo/issues/02-t.md',
            raw: 'ready-for-agent',
          }),
        ],
        frontier: ['02'],
        total: 2,
      }),
    }),
    installed('mattpocock-skills:implement'),
  )

  expect(action?.command).toBe('/mattpocock-skills:implement .scratch/demo/issues/02-t.md')
  expect(action?.text).toContain('01 built here')
})

test('a frontier marked for a human is reported without a command', () => {
  const action = nextAction(
    feature({
      matt: mattResult('plan', {
        items: [
          item('04', 'open', { path: '.scratch/demo/issues/04-t.md', raw: 'ready-for-human' }),
        ],
        frontier: ['04'],
      }),
    }),
    installed('mattpocock-skills:implement', 'mattpocock-skills:ask-matt'),
  )

  expect(action?.command).toBe(undefined)
  expect(action?.text).toContain('ticket 04 is marked for a human')
})

test('a frontier needing triage is named and sent to triage', () => {
  const action = nextAction(
    feature({
      matt: mattResult('plan', {
        items: [item('06', 'open', { path: '.scratch/demo/issues/06-t.md', raw: 'needs-triage' })],
        frontier: ['06'],
      }),
    }),
    installed('mattpocock-skills:triage'),
  )

  expect(action?.command).toBe('/mattpocock-skills:triage')
  expect(action?.text).toContain('ticket 06 needs triage')
})

test('a completed Matt-only feature drafts the pull request body', () => {
  const action = nextAction(
    feature({
      matt: mattResult('done', {
        docs: { tickets: '.scratch/demo/issues/' },
        items: [item('01', 'complete', { path: '.scratch/demo/issues/01-t.md', raw: 'done' })],
        total: 1,
      }),
      merged: false,
    }),
    installed('mattpocock-skills:pr'),
  )

  expect(action?.command).toBe('/mattpocock-skills:pr')
  expect(action?.text).toContain('writes the pull request body')
})

test('a Matt feature with no matching next step asks Matt', () => {
  const action = nextAction(
    feature({ matt: mattResult('unknown') }),
    installed('mattpocock-skills:ask-matt'),
  )

  expect(action?.command).toBe('/mattpocock-skills:ask-matt')
  expect(action?.text).toContain("not sure what's next: ask Matt's guide")
})

test('only Matt commands installed offers ask-matt without a Matt result', () => {
  const action = nextAction(feature(), installed('mattpocock-skills:wayfinder'))

  expect(action?.command).toBe(undefined)
  expect(action?.missing).toBe('mattpocock-skills:ask-matt')
  expect(action?.text).toContain("not sure what's next: ask Matt's guide")
})

test('a ticket with related commits is not offered for implementation', () => {
  const matt = readMatt({
    folder: '.scratch/demo',
    hasSpec: true,
    hasMap: false,
    tickets: [
      {
        key: '01',
        slug: 't',
        title: 'Ticket t',
        path: '.scratch/demo/issues/01-t.md',
        status: 'ready-for-agent',
        blockedBy: [],
      },
      {
        key: '02',
        slug: 'next',
        title: 'Next ticket',
        path: '.scratch/demo/issues/02-next.md',
        status: 'ready-for-agent',
        blockedBy: [],
      },
    ],
    unreadable: [],
    observed: [],
    relatedKeys: ['01'],
  })
  const action = nextAction(feature({ matt }), installed('mattpocock-skills:implement'))

  expect(action?.command).toBe('/mattpocock-skills:implement .scratch/demo/issues/02-next.md')
  expect(action?.text).toContain('implement the next ready ticket')
})

test('no matching evidence or Matt installation yields no next action', () => {
  const state = feature({ sp: superpowers('unknown', { docs: {} }) })
  const action = nextAction(state, installed('superpowers:writing-plans'))

  expect(phaseOf(state).phase).toBe('unknown')
  expect(action).toBe(null)
})

test('a mixed feature takes phase and count from its Superpowers plan', () => {
  const headline = phaseOf(
    feature({
      sp: superpowers('build', {
        items: [
          item('Task 1', 'complete', { kind: 'task' }),
          item('Task 2', 'open', { kind: 'task' }),
        ],
        total: 2,
      }),
      matt: mattResult('done', { total: 3, decisions: [1, 3] }),
    }),
  )

  expect(headline).toEqual({
    phase: 'build',
    weak: false,
    count: [1, 2],
    decisions: [1, 3],
    blocked: 0,
  })
})

test('phaseOf counts needs-info tickets as blocked', () => {
  const headline = phaseOf(
    feature({
      matt: mattResult('build', {
        items: [item('01', 'blocked', { path: '.scratch/demo/issues/01-t.md', raw: 'needs-info' })],
        total: 1,
      }),
    }),
  )

  expect(headline.blocked).toBe(1)
})

test('phaseOf does not count a parked finding as blocked', () => {
  const headline = phaseOf(
    feature({
      sp: superpowers('done', {
        items: [item('Task 1', 'complete', { kind: 'task', parked: 1 })],
        total: 1,
      }),
    }),
  )

  expect(headline.phase).toBe('done')
  expect(headline.count).toEqual([1, 1])
  expect(headline.blocked).toBe(0)
})

test('phaseOf marks a done feature merged only when merge evidence is true', () => {
  const cases = [
    [true, 'merged'],
    ['unknown', 'done'],
    [false, 'done'],
    ['n/a', 'done'],
  ] as const

  for (const [merged, phase] of cases) {
    expect(phaseOf(feature({ sp: superpowers('done'), merged })).phase).toBe(phase)
  }
})
