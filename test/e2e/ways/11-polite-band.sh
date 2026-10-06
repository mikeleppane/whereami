#!/bin/sh
# Way 11: another plugin's band loaded below whereami's: whereami calls next(e) and stacks its line right above the
# other one, so both are on screen.
# shellcheck source=test/e2e/lib.sh
. "$(dirname "$0")/../lib.sh"

start_way 11-polite-band
PLUGINS='superpowers mattpocock-skills polite-band'
mkrepo
SPEC=docs/superpowers/specs/2026-10-05-x-design.md
PLAN=docs/superpowers/plans/2026-10-05-x.md
L=$REPO/.superpowers/sdd/x
if ! { git -C "$REPO" checkout -q -b feat/x &&
	mkdir -p "$REPO/${SPEC%/*}" "$L" && printf '# X\n' >"$REPO/$SPEC" && plan "$REPO/$PLAN" "$SPEC" &&
	git -C "$REPO" add docs && git -C "$REPO" commit -q -m 'spec and plan' &&
	printf '%s\n' "$PLAN" >"$L/plan-path" &&
	printf '# SDD ledger — plan: %s\nTask 1: complete (commits a..b, review clean)\n' "$PLAN" >"$L/progress.md"; }; then
	fail 'repo'
fi

session "$REPO"
poll 30 'screen | grep -A 1 "whereami · x · build 1/3" | grep -q "^ *polite band *$"' ||
	fail 'the screen never showed the whereami band right above the polite band'

end_way
