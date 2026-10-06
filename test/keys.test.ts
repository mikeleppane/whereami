import { expect, test } from 'claude-code/testing'
import { jsonString, keyOf } from '../src/keys'
import { KEYS } from './fixtures/keys'

test('keyOf matches the shared key list', () => {
  for (const [name, key] of KEYS) expect(keyOf(name)).toBe(key)
})

test('jsonString is printable ASCII and round-trips', () => {
  const s = 'Task 5 "parked" — ä\nnext\u0007'
  expect(/^[\x20-\x7e]*$/.test(jsonString(s))).toBe(true)
  expect(JSON.parse(`"${jsonString(s)}"`)).toBe(s)
  expect(jsonString('\b\t\n\f\r')).toBe('\\u0008\\u0009\\u000A\\u000C\\u000D')
  expect(jsonString('C:\\new\\"x"')).toBe('C:\\\\new\\\\\\"x\\"')
})
