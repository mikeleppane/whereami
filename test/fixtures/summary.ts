// Spec section 7's session summary example as src/notes.ts writes it: the first line of the message and
// detail files. test/text.test.ts writes them from a real view; test/hook.test.sh prints them.
export const SUMMARY_FILES = {
  message: 'whereami \\u00B7 auth-refresh \\u00B7 build 4/7 recorded complete',
  detail:
    '\\u000A  findings: 2 parked for the final review\\u000A  next: resume /superpowers:subagent-driven-development docs/superpowers/plans/2026-10-05-auth-refresh.md\\u000A  docs: docs/superpowers/specs/2026-10-05-auth-refresh-design.md, docs/superpowers/plans/2026-10-05-auth-refresh.md',
}
