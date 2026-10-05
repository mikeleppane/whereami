const hex = (n: number, width: number) => n.toString(16).toUpperCase().padStart(width, '0')

// File key for a branch name or path: UTF-8 bytes, every byte outside [A-Za-z0-9._-] as %XX.
// hooks/ must compute the same key; test/fixtures/keys.ts pins both.
export function keyOf(name: string): string {
  let key = ''
  for (const b of new TextEncoder().encode(name)) {
    const c = String.fromCharCode(b)
    key += /[A-Za-z0-9._-]/.test(c) ? c : `%${hex(b, 2)}`
  }
  return key
}

// JSON string body (no quotes) in printable ASCII: `"` and `\` backslashed, every non-ASCII and
// control character as \uXXXX (never the short \n, \t forms).
export function jsonString(text: string): string {
  return text.replace(/["\\]|[^\x20-\x7e]/g, (c) =>
    c === '"' || c === '\\' ? `\\${c}` : `\\u${hex(c.charCodeAt(0), 4)}`,
  )
}
