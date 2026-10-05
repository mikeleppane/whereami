import { expect, test } from 'claude-code/testing'
import { branchFiles, parseNote, paths, serializeNote } from '../src/notes'
import type { Note } from '../src/types'

const NOTE: Note = {
  version: 1,
  id: 'auth-refresh',
  branches: ['feat/auth-refresh'],
  unlinked: [],
  tips: { 'feat/auth-refresh': '3f2a9c1' },
  docs: { plan: 'docs/superpowers/plans/2026-10-05-auth-refresh.md' },
  planTasks: ['Task 1: Add token store'],
  observed: [
    {
      skill: 'superpowers:writing-plans',
      doc: 'p.md',
      branch: null,
      head: null,
      at: '2026-10-05T14:02:00Z',
    },
  ],
  last: {
    phase: 'build',
    tasks: {
      '1': { state: 'complete', reviewed: true, fixRound: [2, 5], evidence: 'review clean' },
    },
    allComplete: false,
    ledgerSeen: true,
    seen: '2026-10-05T14:32:00Z',
  },
}

test('parseNote reads back what serializeNote wrote', () => {
  expect(parseNote(serializeNote(NOTE))).toEqual(NOTE)
})

test('parseNote rejects broken JSON, another version and a field of the wrong type', () => {
  expect(parseNote('{')).toBe(null)
  expect(parseNote('{"version":2,"id":"a"}')).toBe(null)
  expect(parseNote(JSON.stringify({ ...NOTE, branches: 'x' }))).toBe(null)
  for (const field of ['branches', 'unlinked', 'planTasks', 'observed', 'tips', 'docs']) {
    expect(parseNote(JSON.stringify({ ...NOTE, [field]: null }))).toBe(null)
  }
})

test('parseNote fills fields left out', () => {
  expect(parseNote('{"version":1,"id":"a"}')).toEqual({
    version: 1,
    id: 'a',
    branches: [],
    unlinked: [],
    tips: {},
    docs: {},
    planTasks: [],
    observed: [],
    last: null,
  })
})

test('branchFiles writes message as one JSON string line and a dot line', () => {
  const text = 'Task 2 "parked" ä'
  const files = branchFiles({
    featureId: 'a',
    name: 'feat/a',
    seen: 1791200000,
    message: text,
    context: 'c',
    agents: '',
    watch: [],
  })
  expect(files.message.endsWith('\n.\n')).toBe(true)
  expect(JSON.parse(`"${files.message.split('\n')[0]}"`)).toBe(text)
})

test('branchFiles writes watch as one path per line, a lone line break when there is none', () => {
  const s = { featureId: 'a', name: 'b', seen: 1, message: 'm', context: 'c', agents: '' }
  expect(branchFiles({ ...s, watch: [] }).watch).toBe('\n')
  expect(branchFiles({ ...s, watch: ['/r/a.md', '/r/b c'] }).watch).toBe('/r/a.md\n/r/b c\n')
})

test('paths keys branches and detached worktrees under the common dir', () => {
  const p = paths('/r/.git')
  expect(p.branch('feat/a', '/r')).toBe('/r/.git/whereami/branches/feat%2Fa')
  expect(p.branch(null, '/r/wt')).toBe('/r/.git/whereami/branches/detached-%2Fr%2Fwt')
  expect(paths('C:/r/.git').root).toBe('C:/r/.git/whereami')
})
