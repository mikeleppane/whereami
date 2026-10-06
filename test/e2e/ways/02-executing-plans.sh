#!/bin/sh
# Way 2: a Superpowers executing-plans build: /whereami shows the task's test evidence from the ledger and drafts the
# same build skill to resume.
# shellcheck source=test/e2e/lib.sh
. "$(dirname "$0")/../lib.sh"

start_way 02-executing-plans
mkrepo
SPEC=docs/superpowers/specs/2026-10-05-x-design.md
PLAN=docs/superpowers/plans/2026-10-05-x.md
if ! { git -C "$REPO" checkout -q -b feat/x &&
	mkdir -p "$REPO/${SPEC%/*}" && printf '# X\n' >"$REPO/$SPEC" && plan "$REPO/$PLAN" "$SPEC" &&
	git -C "$REPO" add docs && git -C "$REPO" commit -q -m 'spec and plan'; }; then
	fail 'repo'
fi

session "$REPO"
say 'execute the plan'
wait_file "$REPO/.git/whereami/branches/feat%2Fx/message" 'build 1/3 recorded complete$'

send /whereami
expect_pane 'Task 1 One · complete · recorded: commits a\.\.b, tests: npm test → 8/8 pass'
expect_pane "\[ Draft /superpowers:executing-plans $PLAN \]"

end_way
