#!/bin/sh
# Way 8: two features built in two worktrees of one repository: each worktree's start names its own feature.
# shellcheck source=test/e2e/lib.sh
. "$(dirname "$0")/../lib.sh"

start_way 08-two-worktrees
mkrepo
B=$REPO/.git/whereami/branches

# worktree NAME: .worktrees/NAME on branch feat/NAME, holding feature NAME's committed spec and plan.
worktree() {
	w_t=$REPO/.worktrees/$1
	w_spec=docs/superpowers/specs/2026-10-05-$1-design.md
	git -C "$REPO" worktree add -q -b "feat/$1" "$w_t" &&
		mkdir -p "$w_t/${w_spec%/*}" && printf '# %s\n' "$1" >"$w_t/$w_spec" &&
		plan "$w_t/docs/superpowers/plans/2026-10-05-$1.md" "$w_spec" &&
		git -C "$w_t" add docs && git -C "$w_t" commit -q -m "$1 spec and plan"
}
{ printf '.worktrees/\n' >>"$REPO/.git/info/exclude" && worktree a && worktree b; } || fail 'repo'

headless "$REPO/.worktrees/a" 'build plan a'
headless "$REPO/.worktrees/b" 'build plan b'
wait_file "$B/feat%2Fa/message" 'build 1/3 recorded complete$'
wait_file "$B/feat%2Fb/message" 'build 2/3 recorded complete$'

# start_in NAME N OTHER: a session in worktree NAME starts with feature NAME at build N/3 and never names feature OTHER.
start_in() {
	session "$REPO/.worktrees/$1"
	started startup "whereami · $1 · build $2/3 recorded complete · as of "
	! screen | grep -q "whereami · $3" || fail "worktree $1 shows feature $3"
	quit
}
start_in a 1 b
start_in b 2 a

end_way
