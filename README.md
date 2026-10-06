# whereami

whereami is a Claude Code plugin that answers "where was I?" for people who build with
[Superpowers](https://github.com/obra/superpowers), [Matt Pocock's skills](https://github.com/mattpocock/skills),
or both mixed in one feature.

After a break, a restart or `/clear`, it shows which feature you are on, its documents, the recorded progress,
the blockers and the next action:

```text
whereami · auth-refresh · build 4/7 recorded complete · as of 14:32 (2 h ago)
  findings: 2 parked for the final review
  next: resume /superpowers:subagent-driven-development docs/superpowers/plans/2026-10-05-auth-refresh.md
  docs: docs/superpowers/specs/2026-10-05-auth-refresh-design.md, docs/superpowers/plans/2026-10-05-auth-refresh.md
```

whereami is a progress and recovery companion. It does not stop premature coding, does not detect drift and
does not replace either library's workflow. It only reads: it never edits your files, makes network calls or
calls a model. Release notes are in [CHANGELOG.md](CHANGELOG.md).

## Start here

| You want to | Read |
| --- | --- |
| Install it and try it | [Install](#install) |
| Know what each line means | [What you see](#what-you-see) and [Evidence](#evidence) |
| Find out why nothing shows | [When whereami shows nothing](#when-whereami-shows-nothing) |
| Know what it stores and remove it | [Your data](#your-data) |
| Change it and send a pull request | [Contributing](#contributing) and [AGENTS.md](AGENTS.md) |

[GLOSSARY.md](GLOSSARY.md) defines the vocabulary (feature, spec, plan, ticket, map, ledger, blocked, waiting).
[docs/adr/](docs/adr/) records the lasting design decisions.

## Install

Claude Code 2.1.289 or later is required. Marketplace installation will come with the first release. For local
use, clone this repository and start Claude Code with it:

```sh
git clone https://github.com/mikeleppane/whereami.git
claude --plugin-dir whereami
```

There is nothing to configure.

## What you see

**At session start**, Claude Code shows the saved summary for the current branch, as above. When files it
watches changed since the summary was saved, it adds `files changed since; open /whereami for a fresh look`.
After `/clear` or a compaction, the summary also lists the agents that are still running.

**Above the prompt**, a band keeps the feature in view:

```text
whereami · auth-refresh · build 4/7 · 1 blocked · 2 agents running
```

The agents count covers every background agent of the session, not only those working on this feature.

**`/whereami`** opens a view of the feature's documents, task or ticket states, evidence and its source, notes,
and the next action. The `Draft <command>` button puts that action into an empty prompt box; you press Enter. When the box
already holds text, whereami leaves it alone and copies the command instead.

**When more than one feature could match**, the band says so:

```text
whereami · 2 features could match · /whereami to choose
```

The view lists why each feature matched and offers a `This is <id>` button for each. Nothing is drafted until you
choose.

**`/whereami forget`** forgets the current feature without opening the view.

## Evidence

Every status carries its evidence:

- **recorded**: written in a library's own file;
- **observed**: whereami saw a library skill start on this work here, and counts the commits after it;
- **related**: inferred from commits only;
- **unknown**: whereami cannot tell, and says so.

Observed and related statuses are marked with `?`, as in `build 4/7 ?`. Unknown is never shown as absent, and
whereami never guesses: when a library's files do not match a supported format, it shows "unsupported format"
instead of a best-effort reading.

For Matt Pocock's skills, whereami reads the local tracker only: specs, maps and tickets under
`.scratch/<feature>/`. GitHub-backed tickets are unsupported.

Matt's default local tracker does not close build tickets as work is committed. For exact counts, adopt the
optional rule "close a ticket when its work is committed". whereami works without this rule.

## When whereami shows nothing

whereami shows nothing, and never blocks a session, when:

- the folder is not in a Git repository;
- Claude Code cannot run Git, as in some desktop setups;
- no feature matches the current branch.

A feature matches a branch when a library skill is started with a spec, plan, ticket or map path, when a
Superpowers build ledger is in the worktree, when the session writes such a document, or when the branch's own
commits touch one. To link a feature at once, start its library command with the document's path, for example
`/superpowers:subagent-driven-development docs/superpowers/plans/<plan>.md`.

The summary at session start shows only what an earlier session saved for this branch, so the first session on a
branch starts without one; the band and `/whereami` appear once a feature matches. Headless runs (`claude -p`)
never print the summary.

It works in a subfolder, a linked worktree, a submodule, a repository with no commits, and on a detached HEAD.

## Your data

whereami writes only its own notes, under `<git common dir>/whereami/` (`.git/whereami/` in an ordinary
checkout). Git never commits them, and every worktree of the repository shares them.

Cleanup runs at session start. It deletes a feature's notes:

- 14 days after the feature was recorded as done or merged;
- once its notes are more than 14 days old and none of its branches exists, or its only branch is the default
  branch;
- after `/whereami forget`, which hides the feature at once.

Other active features never expire.

To remove everything, uninstall the plugin, then delete the `whereami` folder in the directory this command
prints from any checkout of the repository:

```sh
git rev-parse --path-format=absolute --git-common-dir
```

The text whereami gives the model, at session start and from `/whereami`, holds feature ids, paths, counts,
statuses and the next command only, never the text of your documents, tickets or ledgers. The session-start text is
labelled as a record, not instructions.

## Compatibility

| | |
| --- | --- |
| Claude Code | 2.1.289 minimum and tested |
| Libraries | Superpowers 6.4.2, mattpocock-skills 1.3.1 |
| Platforms | Linux, macOS and Windows (Git Bash) run the hook and the tests in CI; end-to-end scenarios run on Linux |
| Dependencies | none at runtime |

Bands follow plugin load order. whereami passes the other plugins' bands through, but a plugin that does not call
`next(e)` can hide it.

## Repository layout

| Path | What it is |
| --- | --- |
| `hooks/register.tsx` | The Claude Code mod: band, `/whereami` view, drafting and refresh wiring. |
| `hooks/session-start.sh` | The POSIX `sh` SessionStart hook: cleanup, then the saved summary. |
| `src` | Library readers, feature identity, next action, notes and rendering. |
| `test` | Plugin tests (`claude plugin test`), hook tests and shared fixtures. |
| `test/e2e` | End-to-end ways: real Claude Code against a local fake model. [Guide](test/e2e/README.md). |
| `scripts` | Repository tooling, including the release gate. |
| `docs/adr` | Architecture decisions. |

## Contributing

You need Node.js 24 or later with `npm`, `make`, `shellcheck` and `shfmt` (`apt install shellcheck shfmt`, or
`brew install shellcheck shfmt`). Install the locked development tools and list the targets:

```sh
npm ci
make help
```

Run the local gate before every commit:

```sh
make check
```

Run the end-to-end ways with `make e2e`. They use a local fake model server, need no Claude account, and require
`tmux`. [AGENTS.md](AGENTS.md) holds the commit rules and the plugin's hard rules.

## Support

Report problems and ideas as [GitHub issues](https://github.com/mikeleppane/whereami/issues).

## License

[MIT](LICENSE)
