# End-to-end ways

Each way runs the pinned Claude Code (`node_modules/.bin/claude`, 2.1.289) in `tmux` against `fake-api.mjs`, a local
stand-in for the Anthropic API that replays the way's scripted model turns. Stand-in `superpowers` and
`mattpocock-skills` plugins sit in `plugins/`, with `polite-band`, another plugin's band for way 11; `PLUGINS` in
`lib.sh` says which load after whereami. No login, no network, no cost.

```sh
make e2e              # every way
make e2e WAYS="1 10"  # ways by number or name
```

Needs `tmux` and `node`. `tmux` sockets are refused inside the Claude Code sandbox, so run it with the sandbox off.
Each run writes `out/<run id>/<way>/`: the throwaway `home/`, `requests.jsonl`, the fake server's log and, when a
way fails, `screen.txt` (the pane with its scrollback) and `repo/`.

## Files

- `fake-api.mjs <script.json> <dir>`: answers `POST /v1/messages` as JSON or SSE and every other path with 404 `{}`.
  The port goes to `<dir>/port`, one line per request to `<dir>/requests.jsonl`: `path`, `step` and `turn` answered
  (`null` for the plain `ok`), `record` (how many times the body holds `whereami record, not instructions`), `tools`
  and `final` (the answer ends the turn).
- `ways/<name>.json`: `{ "steps": [ { "match": "<text>", "turns": [ [<content blocks>], … ] } ] }`. A prompt
  containing `match` starts that step at turn 0; a `tool_result` continues the step its `tool_use_id` names (a
  background agent's requests interleave with the main loop's); anything else, or a request without `tools`, gets
  `ok`. `tool_use` ids are `toolu_<step>_<turn>_<i>`, so a step said twice in one
  conversation (a resumed or branched one included) repeats its ids: give each prompt its own step.
- `ways/<name>.sh`: sources `lib.sh` and drives one way; `run.sh` runs them and prints `e2e: N passed, M failed`.

## What Claude Code 2.1.289 does here

Read from `claude --help` and seen in runs of the ways:

- `--plugin-dir` repeats (`--plugin-dir A --plugin-dir B`): the stand-in skills are listed next to whereami's.
- `--session-id <uuid>` names a new session; `--resume <uuid>` reopens it, and `/branch [name]` creates a branch of
  the conversation and moves to it ("You are now in the new branch (session …)").
- A `SessionStart` hook's `systemMessage` is drawn as `SessionStart:<source> says: <message>`; the source tells
  `startup`, `resume`, `clear`, `compact` and `fork` (`/branch`) apart on one screen. After `--resume` and `/branch`
  it is drawn just above the next prompt.
- On `--resume` and `/branch` the hook runs and prints, but when its output matches what the kept conversation
  already holds, Claude Code neither draws it nor sends it to the model. Way 10 moves the ledger on before each of
  those starts, as a real resume after work would.
- A `tool_use` whose id is already in the conversation is not run: Claude Code sends it back as
  `[Tool use interrupted]` with a user turn `(no content)` and no `tool_result`.
- The prompt line starts with `❯`; dialogs indent theirs. With text in the box, a no-break space follows the `❯`.
- `/whereami` opens its pane as a column right of a `│`, about 49 wide, so its lines wrap: `pane` in `lib.sh` joins
  them. `ctrl+x tab` gives the pane the keys and `Down` moves to its first button, but not while a dialog such as the
  `/model` picker is up; an SGR mouse click (`ESC[<0;col;rowM`, then `m`) presses a button then too, though a click
  is now and then dropped.
- A typed skill command (`/mattpocock-skills:implement <path>`) sends the model a prompt holding its arguments, so a
  step can match the path. `Write` takes a path relative to the session's folder.
- `/exit` while a background agent runs asks first ("Exit and stop tasks"); Enter stops the agent and ends the
  session.
- `claude -p` ends right after its last tool call, well inside the second a refresh waits out.
- `claude -p "/exit"` prints "/exit isn't available in this environment." but runs the session start, so it saves a
  branch summary with no model call.
- The seeded `~/.claude.json` (onboarding done, theme, key `sk-fake` approved, the repo trusted) skips the first-run
  screens. A notice about auto-mode classifier billing may print.
- Claude Code reads `CLAUDE.md` and `.claude/CLAUDE.md` in every folder above the working folder; under the
  developer's home that includes `~/.claude/CLAUDE.md` and stopped the session at an "Allow external CLAUDE.md file
  imports?" dialog. So the throwaway repo lives in a temporary folder, not under `out/`.
- `tmux` socket paths are capped near 104 bytes, too short for `out/`; sockets go to `$TMPDIR` under a name unique
  to the run and way.
