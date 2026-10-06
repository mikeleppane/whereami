#!/bin/sh
# Way 6: a Matt spec feeding a Superpowers plan (`**Spec:** .scratch/demo/spec.md`) is one feature holding both
# documents, counted by the plan.
# shellcheck source=test/e2e/lib.sh
. "$(dirname "$0")/../lib.sh"

start_way 06-matt-spec-sp-plan
mkrepo
SPEC=.scratch/demo/spec.md
PLAN=docs/superpowers/plans/2026-10-05-demo-build.md
W=$REPO/.git/whereami
if ! { git -C "$REPO" checkout -q -b feat/demo &&
	mkdir -p "$REPO/${SPEC%/*}" && printf '# Demo\n' >"$REPO/$SPEC" && plan "$REPO/$PLAN" "$SPEC" &&
	git -C "$REPO" add .scratch docs && git -C "$REPO" commit -q -m 'spec and plan'; }; then
	fail 'repo'
fi

session "$REPO"
say 'build the plan'
wait_file "$W/branches/feat%2Fdemo/message" 'build 1/3 recorded complete$'
set -- "$W"/features/*
[ "$*" = "$W/features/demo" ] || fail "features: $*, expected demo alone"
expect_file "$W/features/demo/note.json" "\"spec\": \"$SPEC\""
expect_file "$W/features/demo/note.json" "\"plan\": \"$PLAN\""

send /whereami
for p in 'whereami · demo · build 1/3 ' "spec: $SPEC " "plan: $PLAN "; do
	expect_pane "$p"
done

end_way
