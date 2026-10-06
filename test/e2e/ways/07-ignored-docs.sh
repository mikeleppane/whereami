#!/bin/sh
# Way 7: way 1's build with docs/ ignored through .git/info/exclude and never committed gives way 1's band.
# shellcheck source=test/e2e/lib.sh
. "$(dirname "$0")/../lib.sh"

start_way 07-ignored-docs
mkrepo
SPEC=docs/superpowers/specs/2026-10-05-x-design.md
PLAN=docs/superpowers/plans/2026-10-05-x.md
if ! { git -C "$REPO" checkout -q -b feat/x && printf 'docs/\n' >>"$REPO/.git/info/exclude" &&
	mkdir -p "$REPO/${SPEC%/*}" && printf '# X\n' >"$REPO/$SPEC" && plan "$REPO/$PLAN" "$SPEC" &&
	[ -z "$(git -C "$REPO" status --porcelain)" ]; }; then
	fail 'repo'
fi

session "$REPO"
say 'build the plan'
wait_file "$REPO/.git/whereami/branches/feat%2Fx/message" 'build 2/3 recorded complete$'
expect_screen 'whereami · x · build 2/3( |$)'

end_way
