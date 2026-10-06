# Shared helpers for test/e2e/ways/*.sh. Source it: `. "$(dirname "$0")/../lib.sh"`.
# A way runs the pinned Claude Code in tmux against fake-api.mjs with an empty home; nothing from the developer's
# ~/.claude, ~/.tmux.conf or git config is read. Any failed step ends the way: fail saves the screen and exits 1.
# poll evaluates its CONDITION strings: single-quoted expansions, and variables read only there, are intended.
# shellcheck disable=SC2016,SC2034

ROOT=$(cd "$(dirname "$0")/../../.." && pwd -P)
E2E_RUN=${E2E_RUN:-$(date +%Y%m%d-%H%M%S)-$$}
WHY=
FAKE=
SAID=0
GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM

# q WORD: WORD single-quoted for sh.
q() {
	printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# tm ARGS: tmux on this way's own server, UTF-8, no config file.
tm() {
	tmux -u -f /dev/null -L "$SOCK" "$@"
}

# poll SECONDS CONDITION: 0 once the shell string CONDITION holds, 1 when SECONDS pass first. CONDITION sees poll's
# own positional parameters, so callers pass values in named variables.
poll() {
	p_end=$(($(date +%s) + $1))
	until eval "$2"; do
		[ "$(date +%s)" -lt "$p_end" ] || return 1
		sleep 0.2
	done
}

# screen: the visible pane, wrapped lines joined.
screen() {
	tm capture-pane -p -J -t way 2>/dev/null
}

# fail WHY: ends the way as failed, saving the screen with its scrollback to $OUT/screen.txt.
fail() {
	WHY=$1
	tm capture-pane -p -J -S - -t way >"$OUT/screen.txt" 2>/dev/null
	end_way
}

# start_way NAME: $OUT with a seeded home, the fake server on ways/NAME.json, and this way's tmux socket.
start_way() {
	NAME=$1
	OUT=$ROOT/test/e2e/out/$E2E_RUN/$NAME
	# tmux socket paths are capped near 104 bytes, too short for $OUT; the socket name keeps runs apart.
	SOCK=wa-$E2E_RUN-$NAME
	TMUX_TMPDIR=${TMPDIR:-/tmp}
	export TMUX_TMPDIR
	rm -rf "$OUT" && mkdir -p "$OUT/home" || exit 1
	# The repo lives outside the developer's tree: Claude Code reads CLAUDE.md and .claude/CLAUDE.md files in every
	# folder above it, ~/.claude/CLAUDE.md among them. A failed way moves it to $OUT/repo.
	TREPO=$(cd "$(mktemp -d "$TMUX_TMPDIR/wa-repo.XXXXXX")" && pwd -P) || exit 1
	REPO=$TREPO/repo
	trap 'tm kill-server 2>/dev/null; [ -z "$FAKE" ] || kill "$FAKE" 2>/dev/null
		[ -z "$WHY" ] || mv "$REPO" "$OUT/repo" 2>/dev/null; rm -rf "$TREPO"' EXIT
	trap 'exit 1' HUP INT TERM
	printf '{"hasCompletedOnboarding":true,"theme":"dark","customApiKeyResponses":{"approved":["sk-fake"],"rejected":[]},"projects":{"%s":{"hasTrustDialogAccepted":true}}}\n' \
		"$REPO" >"$OUT/home/.claude.json"
	: >"$OUT/requests.jsonl"
	node "$ROOT/test/e2e/fake-api.mjs" "$ROOT/test/e2e/ways/$NAME.json" "$OUT" >"$OUT/fake-api.log" 2>&1 &
	FAKE=$!
	wait_file "$OUT/port"
	PORT=$(cat "$OUT/port")
}

# mkrepo: a throwaway repo at $REPO on main with one commit; the way adds the documents it needs.
mkrepo() {
	if ! { git -c init.defaultBranch=main init -q "$REPO" &&
		git -C "$REPO" config user.name t &&
		git -C "$REPO" config user.email t@example.com &&
		git -C "$REPO" commit -q --allow-empty -m init; }; then
		fail 'mkrepo'
	fi
}

# plan FILE SPEC: a three-task Superpowers plan (Task 1: One, 2: Two, 3: Three) at FILE whose **Spec:** names SPEC.
plan() {
	mkdir -p "${1%/*}" &&
		printf '# Plan\n\n**Spec:** `%s`\n\n### Task 1: One\n\n### Task 2: Two\n\n### Task 3: Three\n' "$2" >"$1"
}

# matt_demo: branch feat/demo with Matt's .scratch/demo spec and ready tickets 01-t and 02-u committed.
matt_demo() {
	m_d=$REPO/.scratch/demo
	if ! { git -C "$REPO" checkout -q -b feat/demo && mkdir -p "$m_d/issues" && printf '# Demo\n' >"$m_d/spec.md" &&
		printf '# T\n\nStatus: ready-for-agent\n' >"$m_d/issues/01-t.md" &&
		printf '# U\n\nStatus: ready-for-agent\n' >"$m_d/issues/02-u.md" &&
		git -C "$REPO" add .scratch && git -C "$REPO" commit -q -m 'spec and tickets'; }; then
		fail 'matt_demo'
	fi
}

# Plugins loaded after whereami, from test/e2e/plugins, in load order. Ways 11 and 12 change it.
PLUGINS='superpowers mattpocock-skills'

# claude_cmd: the pinned Claude Code command line with this plugin, then $PLUGINS, and the fake server.
claude_cmd() {
	printf 'env -i PATH=%s HOME=%s TERM=xterm-256color %s' "$(q "$PATH")" "$(q "$OUT/home")" "${TMPDIR:+TMPDIR=$(q "$TMPDIR") }"
	printf 'ANTHROPIC_BASE_URL=http://127.0.0.1:%s ANTHROPIC_API_KEY=sk-fake ' "$PORT"
	printf 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 '
	printf '%s --plugin-dir %s ' "$(q "$ROOT/node_modules/.bin/claude")" "$(q "$ROOT")"
	for c_p in $PLUGINS; do printf -- '--plugin-dir %s ' "$(q "$ROOT/test/e2e/plugins/$c_p")"; done
	printf -- '--permission-mode default --allowedTools=Bash,Read,Write,Edit,Skill'
}

# headless DIR ARGS: claude_cmd -p ARGS in DIR, outside tmux; its output goes to $OUT/headless.log.
headless() {
	h_dir=$1
	shift
	h_cmd="$(claude_cmd) -p"
	for a; do h_cmd="$h_cmd $(q "$a")"; done
	(cd "$h_dir" && eval "$h_cmd") </dev/null >>"$OUT/headless.log" 2>&1 || fail "claude -p $*"
}

# session DIR ARGS: claude_cmd ARGS in tmux in DIR (120x40), once its prompt is drawn. The pane stays after exit.
session() {
	s_dir=$1
	shift
	s_cmd=$(claude_cmd)
	for a; do s_cmd="$s_cmd $(q "$a")"; done
	tm kill-server 2>/dev/null
	tm new-session -d -s way -x 120 -y 40 -c "$s_dir" "$s_cmd" \; set-option -g remain-on-exit on ||
		fail 'tmux did not start'
	poll 60 'screen | grep -q "^❯"' || fail 'no prompt within 60 s'
}

# send TEXT: types TEXT and Enter.
send() {
	tm send-keys -t way -l "$1" && tm send-keys -t way Enter
}

# say TEXT: sends TEXT, which starts a step of the way's script, then waits until that step has no turn left. Other
# requests (titles, compaction) do not end the wait.
# The wait names the step TEXT starts, as fake-api.mjs matches it: Claude Code may repeat an earlier step's last
# request, and a wait that ended on it would type the next prompt into a running turn.
say() {
	s_n=$(wc -l <"$OUT/requests.jsonl")
	s_step=$(node -e 'const [f, t] = process.argv.slice(1)
const i = JSON.parse(require("fs").readFileSync(f, "utf8")).steps.findIndex((s) => t.includes(s.match))
console.log(i < 0 ? "[0-9]+" : i)' "$ROOT/test/e2e/ways/$NAME.json" "$1")
	send "$1"
	# An Enter the slash-command menu takes leaves TEXT in the box with nothing sent; press it once more.
	if ! poll 10 '[ "$(wc -l <"$OUT/requests.jsonl")" -gt "$s_n" ]' &&
		[ "$(screen | grep '^❯' | tail -n 1 | sed 's/ *$//')" = "❯ $1" ]; then
		tm send-keys -t way Enter
	fi
	poll 60 'tail -n +$((s_n + 1)) "$OUT/requests.jsonl" | grep -Eq "\"step\":$s_step,.*\"final\":true"' ||
		fail "no answer to: $1"
	SAID=$s_n
}

# quit: /exit, then waits for Claude Code to end.
quit() {
	send /exit
	poll 30 '[ "$(tm display-message -p -t way "#{pane_dead}")" = 1 ]' || fail '/exit did not end the session'
}

# wait_file PATH [REGEX]: waits up to 30 s for PATH to exist and, given REGEX, to hold a line matching it.
wait_file() {
	w_path=$1 w_re=${2:-}
	poll 30 '[ -f "$w_path" ] && { [ -z "$w_re" ] || grep -Eq -- "$w_re" "$w_path"; }' ||
		fail "no file $1${2:+ matching $2}"
}

# expect_screen REGEX: the visible pane shows REGEX within 30 s.
expect_screen() {
	e_re=$1
	poll 30 'screen | grep -Eq -- "$e_re"' || fail "screen never showed $1"
}

# pane: the side pane /whereami opens, right of the last │ on each screen line, its wrapped lines joined into one.
pane() {
	screen | sed -n 's/.*│//p' | tr -s ' \n' '  '
}

# expect_pane REGEX: the pane shows REGEX within 30 s.
expect_pane() {
	e_re=$1
	poll 30 'pane | grep -Eq -- "$e_re"' || fail "the pane never showed $1"
}

# expect_file PATH REGEX: PATH holds a line matching REGEX.
expect_file() {
	grep -Eq -- "$2" "$1" 2>/dev/null || fail "$1 does not match $2"
}

# expect_request REGEX: a requests.jsonl line since the last say matches REGEX.
expect_request() {
	tail -n +$((SAID + 1)) "$OUT/requests.jsonl" | grep -Eq -- "$1" || fail "no request since the last say matches $1"
}

# record: how many times the newest prompt's request held the hook's record.
record() {
	grep '"turn":0,' "$OUT/requests.jsonl" | tail -n 1 | sed 's/.*"record":\([0-9]*\).*/\1/'
}

# started SOURCE REGEX [AT_LEAST]: says "where are we, SOURCE" (the way's step for it); the hook's summary for a
# SOURCE start, matching REGEX, is then on screen, and the prompt's request holds the record AT_LEAST times (1).
# Claude Code may draw a start's message only with the next prompt, so the prompt comes first.
started() {
	say "where are we, $1"
	expect_screen "SessionStart:$1 says: $2"
	[ "$(record)" -ge "${3:-1}" ] || fail "$1: the prompt's request holds the record $(record) times, expected ${3:-1}"
}

# end_way: quits a live session, then prints PASS NAME or FAIL NAME: WHY and exits; the EXIT trap stops tmux and the
# fake server.
end_way() {
	if [ -z "$WHY" ] && [ "$(tm display-message -p -t way '#{pane_dead}' 2>/dev/null)" = 0 ]; then
		quit
	fi
	if [ -z "$WHY" ]; then
		echo "PASS $NAME"
		exit 0
	fi
	echo "FAIL $NAME: $WHY"
	exit 1
}
