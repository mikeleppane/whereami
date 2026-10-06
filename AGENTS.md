# Agent skills

## Issue tracker

Issues and specs live as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

## Triage labels

Default five-role vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

## Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Checks and commits

- `make check` is the required gate before every commit. `make help` lists the other Make targets.
- Commit subjects use Conventional Commits: `type(scope): subject`, with types `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`, or `revert`; scopes `hook`, `mod`, `readers`, `e2e`, `ci`, `docs`, `repo`, or `deps`; a lower-case subject of at most 72 characters with no trailing period. Do not add AI attribution.
- Stage named paths only. Never use `git add -A` or `git add .`; do not commit `.superpowers/`, `docs/superpowers/`, `docs/reviews/`, `docs/verification.md`, or `.scratch/`.

## Plugin and test constraints

- Claude Code 2.1.289 is the minimum. The plugin has no runtime dependencies; `package.json` contains development tools only. The mod runs as ES modules without Node, a DOM or timers: do not use `require`, dynamic `import()` or `setTimeout`; wait with `$.clock`. Import project files with extensionless relative paths.
- `Makefile` places `node_modules/.bin` first on `PATH`, and disables automatic updates; checks and E2E use the pinned Claude Code 2.1.289.
- In plugin tests, `$` is the engine as plugins see it. Hooks answer operation events (`fs.*`, `process.run`, `prompt.read`, `prompt.fill`, `ui.copy`, `command.list`, `agent.list`) with `{ value: <result> }` or `{ deny }`, never a bare result. Use `mock.clock(on)` and move time with `advance(ms)` or `settle()`. Draw with `$.ui.mount({ plugin: 'whereami', surface, component, props, requestId })`; use the returned handle's `drawn`, `find` and `press`.
- Supply complete event inputs. `command.run` needs `command`, `args`, `origin` and `presentation`; `session.end` needs `reason`, `sessionId` and `resume`. A `prompt.fill` refusal reason written by a test hook is stripped by the engine; only the engine's `dialog` and `no_composer` reasons survive.
- `claude plugin test .` runs all `*.test.ts(x)` files. `make types` generates `.claude-plugin/types/` using `claude -p --plugin-dir . "/exit"` without login or a model call.
- E2E uses a local fake model server, never a real account or cloud API. See `test/e2e/README.md`; running it requires `tmux`.

## Hard rules

- The mod only reads library files and runs read-only Git commands: `rev-parse`, `symbolic-ref`, `show-ref`, `for-each-ref`, `ls-tree`, `log`, `worktree list`, `cat-file --batch`, `merge-base` and `branch --merged`. It writes only below `<git common dir>/whereami/`; document, ticket and ledger text never goes to the model, including through `additionalContext` or `command.run`.
- On events whereami does not own, call `next(e)` before doing work; the `/whereami` `command.run` handler answers itself. Hooks must not throw. Guard `$.agent.list()` because it throws under `claude -p`.
- Keep `hooks/session-start.sh` POSIX `sh`: no `jq` or bash-specific syntax, and always `exit 0`. It deletes only below an absolute path ending in `/whereami`.
- Branch and feature keys encode every byte outside `[A-Za-z0-9._-]` as uppercase `%XX` in both TypeScript and the hook; `test/fixtures/keys.ts` is the shared test list. Do not let the two implementations diverge.
- Keep the established limits: 14 days is `1209600` seconds, file reads cap at `1048576` bytes, and refreshes are throttled to `1000` ms. Running agents have status `pending`, `running` or `waiting`; finished agents have status `completed`, `failed` or `killed`.
- `$.process.run` caps stdout at 4 MiB; never parse truncated output as complete evidence. Do not call `$.session.usage({ breakdown: 'full' })`.
- The source layout intentionally splits spec section 2's `src/render.ts` into `src/text.ts` and `src/render.tsx`, and `src/refresh.ts` into `src/gather.ts` and `src/refresh.ts`.
- Keep public files free of personal paths and secrets.
