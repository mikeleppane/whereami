#!/bin/sh
# Way 14: drafting from /whereami. Draft pressed while the /model picker is open asks to close the dialog; pressed
# with text in the prompt box, it leaves the text alone and copies the command instead.
# poll evaluates its condition string: its single-quoted expansions, and d_re read only there, are intended.
# shellcheck disable=SC2016,SC2034
# shellcheck source=test/e2e/lib.sh
. "$(dirname "$0")/../lib.sh"

start_way 14-drafting
mkrepo
SPEC=docs/superpowers/specs/2026-10-05-x-design.md
PLAN=docs/superpowers/plans/2026-10-05-x.md
if ! { git -C "$REPO" checkout -q -b feat/x &&
	mkdir -p "$REPO/${SPEC%/*}" && printf '# X\n' >"$REPO/$SPEC" && plan "$REPO/$PLAN" "$SPEC" &&
	git -C "$REPO" add docs && git -C "$REPO" commit -q -m 'spec and plan'; }; then
	fail 'repo'
fi

# draft NOTICE: clicks the pane's Draft button (an SGR mouse press, then release, on its first line; a dialog holds
# the keys) until the pane shows NOTICE. Claude Code sometimes drops a click, and both presses here only refuse or
# copy, so pressing again is safe; three clicks with no NOTICE fail.
draft() {
	d_n=0
	while [ "$d_n" -lt 3 ]; do
		d_n=$((d_n + 1))
		d_row=$(screen | grep -n '│\[ Draft' | cut -d: -f1)
		[ -n "$d_row" ] || fail 'no Draft button to press'
		tm send-keys -t way -l "$(printf '\033[<0;75;%sM' "$d_row")"
		tm send-keys -t way -l "$(printf '\033[<0;75;%sm' "$d_row")"
		d_re=$1
		poll 5 'pane | grep -Eq -- "$d_re"' && return
	done
	fail "the pane never showed $1"
}

session "$REPO"
send /whereami
expect_pane "\[ Draft /superpowers:subagent-driven-development $PLAN \]"

send /model
expect_screen 'Enter to set as default .* Esc to cancel'
draft '✕ close the dialog, then press Draft again '
tm send-keys -t way Escape
poll 30 '! screen | grep -q "Select model"' || fail 'the /model picker did not close'

tm send-keys -t way -l 'keep this text'
expect_screen '^❯[^a-z]+keep this text *$'
draft '✕ your prompt has text, so the command was copied instead '
expect_screen '^❯[^a-z]+keep this text *$'

tm send-keys -t way C-u
expect_screen '^❯[^a-z]*$'
end_way
