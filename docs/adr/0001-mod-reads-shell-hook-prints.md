# A mod does the reading; a plain shell hook only cleans up and prints

whereami is two parts in one plugin. The mod (TypeScript, running inside Claude Code) reads the libraries' files and git, decides the feature and its progress, and writes the summary. A plain SessionStart shell hook deletes expired or forgotten notes, then prints the saved summary with its age and a "files changed since" warning. We split it this way because a mod's file API has no delete, so expiry and forgetting need a process that can remove files; and because a settings hook keeps printing the last summary even when the mod fails to load.

## Consequences

- The files the hook prints are one-line strings already JSON-escaped by the mod and closed by a sentinel line, so the shell never builds or escapes JSON. From its own stdin it reads only two known string fields, `source` and `cwd`, with `sed`; it needs no `jq`.
- All interpretation lives in the mod. The hook must never grow parsing logic; if it needs a new fact, the mod writes it as another plain file.
- The summary is as old as the mod's last refresh. The hook says how old, and warns when watched files changed or disappeared since.

## Considered options

- **Everything in the mod**, printing through its own `classic.SessionStart` hook. Rejected: without delete, expired and forgotten notes would stay on disk for good, and a mod that fails to load would show nothing.
- **Everything in the shell hook.** Rejected: parsing plans, ledgers, tickets and git history in POSIX `sh` is fragile, and the hook only runs at session start, so the band could not stay live.
