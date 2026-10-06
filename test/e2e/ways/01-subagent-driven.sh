#!/bin/sh
# Way 1: a Superpowers subagent-driven build counts its tasks from the ledger, shows review while the ledger holds
# every task complete and done once it is removed; the next start suggests finishing the branch and /whereami lists
# every task from the progress file.
# shellcheck source=test/e2e/lib.sh
. "$(dirname "$0")/../lib.sh"

start_way 01-subagent-driven
mkrepo
SPEC=docs/superpowers/specs/2026-10-05-x-design.md
PLAN=docs/superpowers/plans/2026-10-05-x.md
B=$REPO/.git/whereami/branches/feat%2Fx
if ! { git -C "$REPO" checkout -q -b feat/x &&
	mkdir -p "$REPO/${SPEC%/*}" && printf '# X\n' >"$REPO/$SPEC" && plan "$REPO/$PLAN" "$SPEC" &&
	git -C "$REPO" add docs && git -C "$REPO" commit -q -m 'spec and plan'; }; then
	fail 'repo'
fi

session "$REPO"
say 'build the plan'
wait_file "$B/message" 'build 2/3 recorded complete$'
expect_screen 'whereami · x · build 2/3( |$)'

say 'finish the build'
wait_file "$B/message" 'review 3/3 recorded complete$'
expect_screen 'whereami · x · review 3/3( |$)'

say 'remove the ledger'
wait_file "$B/message" 'done 3/3 recorded complete$'
quit

session "$REPO"
started startup 'whereami · x · done 3/3 recorded complete · as of '
expect_screen 'next: /superpowers:finishing-a-development-branch \(finish and'

send /whereami
for t in '1 One' '2 Two' '3 Three'; do
	expect_pane "Task $t · complete · reviewed · recorded: commits [a-d]\.\.[a-d], review clean \(from the progress file before it was removed\)"
done

end_way
