#!/bin/sh
# Way 10: a restart, --resume, /clear, /compact and /branch each start with the saved summary and its age on screen,
# and the next request carries the hook's record.
# shellcheck source=test/e2e/lib.sh
. "$(dirname "$0")/../lib.sh"

start_way 10-session-starts
mkrepo
SPEC=docs/superpowers/specs/2026-10-05-x-design.md
PLAN=docs/superpowers/plans/2026-10-05-x.md
L=$REPO/.superpowers/sdd/x
if ! { git -C "$REPO" checkout -q -b feat/x &&
	mkdir -p "$REPO/${SPEC%/*}" "$L" &&
	printf '# X\n' >"$REPO/$SPEC" &&
	plan "$REPO/$PLAN" "$SPEC" &&
	git -C "$REPO" add docs && git -C "$REPO" commit -q -m 'spec and plan' &&
	printf '%s\n' "$PLAN" >"$L/plan-path" &&
	printf '# SDD ledger — plan: %s\n' "$PLAN" >"$L/progress.md"; }; then
	fail 'repo'
fi

# progress N: the ledger records Task N complete, and a session in between saves the branch summary the next start
# prints.
progress() {
	BUILD=$1
	printf 'Task %s: complete (commits a..b, review clean)\n' "$1" >>"$L/progress.md"
	headless "$REPO" /exit
	wait_file "$REPO/.git/whereami/branches/feat%2Fx/message" "build $1/3"
}

ID=6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b

# at SOURCE AT_LEAST: the SOURCE start shows the summary with its age. A start that keeps the conversation (resume,
# /branch) carries the earlier records too, so it must add one. Each start says its own step: a repeated step
# repeats its tool_use ids, and Claude Code turns a tool_use whose id is already in the conversation into "[Tool use
# interrupted]".
at() {
	started "$1" "whereami · x · build $BUILD/3[^·]* · as of [0-2][0-9]:[0-5][0-9] \((just now|[0-9]+ min ago)\)" "$2"
}

progress 1
session "$REPO" --session-id "$ID"
at startup 1
quit

# A resumed start whose hook prints what the conversation already holds is not shown, so the state moves on first.
progress 2
session "$REPO" --resume "$ID"
at resume $(($(record) + 1))

send /clear
at clear 1

send /compact
at compact 1

# /branch copies the conversation, the compact start's record with it, so the state moves on first here too.
say 'start task 3'
wait_file "$REPO/.git/whereami/branches/feat%2Fx/context" 'Task 3 in-progress'
send /branch
at fork $(($(record) + 1))

end_way
