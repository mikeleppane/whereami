import type { Io } from '../src/io'
import type { GitResult } from '../src/types'

// An Io over a map of absolute paths to text and a git answerer: a string answer is code 0 with that
// output, null is code 128.
export function fakeIo(
  files: Record<string, string>,
  git: (args: string[], stdin?: string) => GitResult | string | null,
  now = 0,
): Io & { written: Record<string, string> } {
  const written: Record<string, string> = {}
  return {
    written,
    git: async (args, stdin) => {
      const r = git(args, stdin)
      if (r === null) return { code: 128, out: '', truncated: false }
      return typeof r === 'string' ? { code: 0, out: r, truncated: false } : r
    },
    read: async (path) => {
      const text = files[path]
      return text === undefined ? { ok: false, why: 'missing' } : { ok: true, text }
    },
    write: async (path, text) => {
      files[path] = text
      written[path] = text
      return true
    },
    list: async (dir) => [
      ...new Set(
        Object.keys(files)
          .filter((p) => p.startsWith(`${dir}/`))
          .map((p) => p.slice(dir.length + 1).replace(/\/.*/, '')),
      ),
    ],
    mtimeMs: async (path) => (path in files ? now : null),
    kind: async (path) =>
      path in files
        ? 'file'
        : Object.keys(files).some((p) => p.startsWith(`${path}/`))
          ? 'dir'
          : null,
    now: async () => now,
  }
}
