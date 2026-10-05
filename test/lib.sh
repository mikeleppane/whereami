# Shared helpers for test/*.test.sh. Source it: `. "$(dirname "$0")/lib.sh"`.

ROOT=$(cd "$(dirname "$0")/.." && pwd)
HOOK=$ROOT/hooks/session-start.sh
passed=0
failed=0

# Tests never read the developer's git config or session: an attended session, no global or system config.
CLAUDE_CODE_SESSION_ATTENDED=1
GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_NOSYSTEM=1
export CLAUDE_CODE_SESSION_ATTENDED GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM

# check NAME CONDITION: CONDITION is a shell string, evaluated here.
check() {
	if eval "$2"; then
		passed=$((passed + 1))
		printf 'ok - %s\n' "$1"
	else
		failed=$((failed + 1))
		printf 'not ok - %s\n' "$1"
	fi
}

# summary [LABEL]: prints the counts, exits 1 on any failure.
summary() {
	printf '%s%s passed, %s failed\n' "${1:+$1: }" "$passed" "$failed"
	[ "$failed" -eq 0 ] || exit 1
}

# mkrepo DIR: a repo on main with user t and one empty commit.
mkrepo() {
	git -c init.defaultBranch=main init -q "$1" &&
		git -C "$1" config user.name t &&
		git -C "$1" config user.email t@example.com &&
		git -C "$1" commit -q --allow-empty -m init
}

# put_summary COMMON KEY SEEN MESSAGE CONTEXT AGENTS [WATCH...]: the branch summary files under COMMON/whereami.
put_summary() {
	ps_dir=$1/whereami/branches/$2
	rm -rf "$ps_dir" && mkdir -p "$ps_dir" || return 1
	printf '%s\n' "$3" >"$ps_dir/seen"
	printf '%s\n.\n' "$4" >"$ps_dir/message"
	printf '%s\n.\n' "$5" >"$ps_dir/context"
	if [ -n "$6" ]; then printf '%s\n.\n' "$6"; fi >"$ps_dir/agents"
	shift 6
	for ps_path; do printf '%s\n' "$ps_path"; done >"$ps_dir/watch"
}

# stamp EPOCH: the `touch -t` form of EPOCH in local time.
stamp() {
	date -d "@$1" +%Y%m%d%H%M.%S 2>/dev/null || date -r "$1" +%Y%m%d%H%M.%S
}

# age_file FILE DAYS: sets FILE's mtime DAYS days back.
age_file() {
	touch -t "$(stamp $(($(date +%s) - $2 * 86400)))" "$1"
}

# json_ok: stdin is valid UTF-8 holding one JSON value.
json_ok() {
	node -e 'JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(require("fs").readFileSync(0)))' 2>/dev/null
}

# run_hook SOURCE CWD: the hook's stdout for a SessionStart input, CWD JSON-escaped as Claude Code writes it.
run_hook() {
	rh_cwd=$(printf '%s' "$2" | sed 's/[\\"]/\\&/g')
	printf '{"session_id":"s","transcript_path":"/t.jsonl","cwd":"%s","hook_event_name":"SessionStart","source":"%s"}\n' \
		"$rh_cwd" "$1" | sh "$HOOK"
}
