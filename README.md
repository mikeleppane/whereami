# whereami

whereami is a public, open-source Claude Code plugin for anyone who builds with Superpowers (obra/superpowers), Matt Pocock's skills (mattpocock/skills), or both mixed in one feature.

The promise: after a break, a restart or `/clear`, you can see which feature you are on, its documents, the recorded progress, the blockers and the next action. It is a progress and recovery companion. It does not stop premature coding, does not detect drift and does not replace either library's workflow.

## Install

Claude Code 2.1.289 or later is required. For local use, clone this repository and run:

```sh
claude --plugin-dir <path-to-clone>
```

Marketplace installation will come with the first release.

## What you see

At session start, a summary can look like this:

```text
whereami · auth-refresh · build 4/7 recorded complete · as of 14:32 (2 h ago)
  findings: 2 parked for the final review
  next: resume /superpowers:subagent-driven-development docs/superpowers/plans/2026-10-05-auth-refresh.md
  docs: docs/superpowers/specs/2026-10-05-auth-refresh-design.md, docs/superpowers/plans/2026-10-05-auth-refresh.md
```

The band above the prompt can look like this:

```text
whereami · auth-refresh · build 4/7 · 1 blocked · 2 agents running
```

Observed or related evidence is marked with `?`, as in `build 4/7 ?`. `/whereami` opens a view of the feature's documents, task or ticket states and evidence, notes, and next action. When more than one feature could match, it asks you to choose:

```text
whereami · 2 features could match · /whereami to choose
```

`/whereami forget` forgets the current feature without opening the view.

Every status carries evidence:

- **recorded**: written in a library's own file;
- **observed**: whereami saw a library skill start on this work here, and counts the commits after it; shown with `?`;
- **related**: inferred from commits only; shown with `?`;
- **unknown**.

When a library's files do not match a supported format, whereami shows "unsupported format" instead of attempting a best-effort reading. The view's chooser lists why each feature matched and offers a button labeled `This is <id>` for each candidate.

Matt's default local tracker does not close build tickets as work is committed. For exact counts, the optional tracker rule is to close a ticket when its work is committed; whereami works without this rule.

Outside a Git repository, or where Claude Code cannot run Git, whereami shows nothing.

## Compatibility and safety

- Minimum and tested Claude Code version: 2.1.289.
- Tested with Superpowers 6.4.2 and mattpocock-skills 1.3.1.
- The plugin has no runtime dependencies.
- Linux, macOS and Windows (Git Bash) run the hook and tests in CI; end-to-end scenarios run in CI on Linux.
- Band order follows plugin load order. whereami passes through the other plugins' bands, but a plugin that does not call `next(e)` can hide it.
- whereami reads library files and runs read-only Git commands. It never edits your specs, plans, ledgers, tickets or maps, makes network calls, or makes model calls. It writes its own notes under Git's common directory.

## Contributing

Install the locked development tools and see the available targets:

```sh
npm ci
make help
```

Run the local gate before contributing:

```sh
make check
```

Run the end-to-end ways with:

```sh
make e2e
```

End-to-end tests use a local fake model server and do not need a Claude account. They require `tmux`; see the [end-to-end harness documentation](test/e2e/README.md).

## License

MIT
