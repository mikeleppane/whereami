#!/bin/sh
# Way 9: a spec written on main, then planned and built in a new worktree: the feature's note gains the new branch,
# the worktree starts with the build, and main stops showing the feature.
# poll evaluates its condition string, so its single-quoted expansions are intended.
# shellcheck disable=SC2016
# shellcheck source=test/e2e/lib.sh
. "$(dirname "$0")/../lib.sh"

start_way 09-spec-on-main
mkrepo
W=$REPO/.git/whereami
WT=$REPO/.worktrees/x

session "$REPO"
say 'write the spec'
wait_file "$W/branches/main/message" 'x \\u00B7 design'
expect_screen 'whereami · x · design'
quit

if ! { git -C "$REPO" add docs && git -C "$REPO" commit -q -m 'spec' &&
	printf '.worktrees/\n' >>"$REPO/.git/info/exclude" && git -C "$REPO" worktree add -q -b feat/x "$WT"; }; then
	fail 'worktree'
fi
headless "$WT" 'build in the worktree'
wait_file "$W/branches/feat%2Fx/message" 'build 1/3 recorded complete$'
expect_file "$W/features/x/branches" '^feat/x$'
session "$WT"
started startup 'whereami · x · build 1/3 recorded complete · as of '
quit

# A start on main refreshes there: the feature has a branch of its own, so main's summary is emptied.
headless "$REPO" /exit
M=$W/branches/main/message
poll 30 '[ -f "$M" ] && [ ! -s "$M" ]' || fail "$M still holds a summary"
session "$REPO"
say 'where are we, startup'
[ "$(record)" -eq 0 ] || fail "main's prompt holds the record $(record) times"
! screen | grep -q 'whereami · x' || fail 'main still shows feature x'

end_way
