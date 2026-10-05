// Shared by the mod (test/keys.test.ts) and the hook (Task 4 reads the pairs with sed).
// Keep one pair per line in the form `  ['<name>', '<key>'],`; no name holds `'`.
export const KEYS: [string, string][] = [
  ['main', 'main'],
  ['feat/a', 'feat%2Fa'],
  ['feat_a', 'feat_a'],
  ['feat/ä-x', 'feat%2F%C3%A4-x'],
  ['100%', '100%25'],
  ['-lead', '-lead'],
  ['fix/🐛', 'fix%2F%F0%9F%90%9B'],
  ['/tmp/my repo/wt', '%2Ftmp%2Fmy%20repo%2Fwt'],
  ['C:/Users/me', 'C%3A%2FUsers%2Fme'],
]
