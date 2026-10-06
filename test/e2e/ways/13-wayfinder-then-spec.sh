#!/bin/sh
# Way 13: a wayfinder map counts its decisions; a spec and build tickets written into the same folder later are
# counted apart from them.
# shellcheck source=test/e2e/lib.sh
. "$(dirname "$0")/../lib.sh"

start_way 13-wayfinder-then-spec
mkrepo
D=$REPO/.scratch/demo
M=$REPO/.git/whereami/branches/feat%2Fdemo/message
if ! { git -C "$REPO" checkout -q -b feat/demo && mkdir -p "$D/issues" && printf '# Demo map\n' >"$D/map.md" &&
	printf '# Cache\n\nType: research\nStatus: resolved\n' >"$D/issues/01-cache.md" &&
	printf '# Api\n\nType: grilling\n' >"$D/issues/02-api.md" &&
	printf '# Ui\n\nType: prototype\nBlocked by: 02\n' >"$D/issues/03-ui.md" &&
	git -C "$REPO" add .scratch && git -C "$REPO" commit -q -m 'wayfinder map'; }; then
	fail 'repo'
fi

session "$REPO"
say '/mattpocock-skills:wayfinder .scratch/demo/map.md'
wait_file "$M" 'design \\u00B7 1/3 decisions$'
expect_screen 'whereami · demo · design · 1/3 decisions( |$)'

say 'write the spec and its tickets'
wait_file "$M" 'plan 0/2 recorded complete \\u00B7 1/3 decisions$'
expect_screen 'whereami · demo · plan 0/2 · 1/3 decisions( |$)'

end_way
