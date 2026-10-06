#!/bin/sh
# check evaluates its CONDITION string, so single-quoted expansions and variables used only there are intended.
# Fault-injection PATH changes are deliberately confined to subshells.
# shellcheck disable=SC2016,SC2034,SC2030,SC2031
# shellcheck source=test/lib.sh
. "$(dirname "$0")/lib.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
now=$(date +%s)
has() { case $1 in *"$2"*) ;; *) return 1 ;; esac }

# Keys: the hook's keyof agrees with every pair the mod is tested against.
eval "$(sed -n '/^keyof() {/,/^}/p' "$HOOK")"
tab=$(printf '\t')
pairs=$(sed -n "s/^  \['\(.*\)', '\(.*\)'\],\$/\1\t\2/p" "$ROOT/test/fixtures/keys.ts")
check 'keys fixture yields pairs' '[ -n "$pairs" ]'
while IFS=$tab read -r k_name k_key; do
	check "keyof $k_name" '[ "$(keyof "$k_name")" = "$k_key" ]'
done <<EOF
$pairs
EOF

# Normal checkout, summary 2 h old.
r=$tmp/r
mkrepo "$r"
put_summary "$r/.git" main $((now - 7200)) 'whereami \u00B7 demo' 'a record' ''
out=$(run_hook startup "$r")
check 'normal: message' 'has "$out" "\"systemMessage\":\"whereami \\u00B7 demo"'
check 'normal: age' 'has "$out" "(2 h ago)"'
check 'normal: event name' 'has "$out" "\"hookEventName\":\"SessionStart\""'

# Linked worktree on a non-ASCII branch, in a folder with a space.
git -C "$r" worktree add -q -b 'feat/ä-x' "$tmp/my repo"
put_summary "$r/.git" 'feat%2F%C3%A4-x' "$now" 'whereami \u00B7 wt' 'a record' ''
check 'linked worktree' 'has "$(run_hook startup "$tmp/my repo")" "whereami \\u00B7 wt"'

# Where the session starts inside the repo, and how its cwd is written.
mkdir -p "$r/a/b"
check 'subfolder cwd' 'has "$(run_hook startup "$r/a/b")" "whereami \\u00B7 demo"'
slashed=$(printf '%s' "$r" | sed 's,/,\\/,g')
check 'cwd with \/' 'has "$(printf "{\"cwd\":\"%s\",\"source\":\"startup\"}" "$slashed" | sh "$HOOK")" "whereami \\u00B7 demo"'

# Detached HEAD, started from a subfolder: keyed by the worktree's top level.
git -C "$r" worktree add -q --detach "$tmp/det"
mkdir "$tmp/det/x"
put_summary "$r/.git" "detached-$(keyof "$(git -C "$tmp/det" rev-parse --show-toplevel)")" "$now" 'whereami \u00B7 det' 'a record' ''
check 'detached HEAD' 'has "$(run_hook startup "$tmp/det/x")" "whereami \\u00B7 det"'

# A repo with no commits yet.
git -c init.defaultBranch=main init -q "$tmp/empty"
put_summary "$tmp/empty/.git" main "$now" 'whereami \u00B7 empty' 'a record' ''
check 'no commits' 'has "$(run_hook startup "$tmp/empty")" "whereami \\u00B7 empty"'

# Submodule: its common dir is the superproject's .git/modules/sub.
mkrepo "$tmp/subsrc"
git -C "$r" -c protocol.file.allow=always submodule add -q "$tmp/subsrc" sub 2>/dev/null
put_summary "$r/.git/modules/sub" main "$now" 'whereami \u00B7 sub' 'a record' ''
check 'submodule' 'has "$(run_hook startup "$r/sub")" "whereami \\u00B7 sub"'

# Not a repo.
mkdir "$tmp/plain"
out=$(run_hook startup "$tmp/plain")
status=$?
check 'not a repo: exit 0, nothing printed' '[ "$status" -eq 0 ] && [ -z "$out" ]'

# Half-written or foreign files print nothing; escaped text stays valid JSON.
printf '%s\n' 'whereami \u00B7 demo' >"$r/.git/whereami/branches/main/message"
check 'message without . line' '[ -z "$(run_hook startup "$r")" ]'
put_summary "$r/.git" main "$now" 'say "hi"' 'a record' ''
check 'message with unescaped "' '[ -z "$(run_hook startup "$r")" ]'
put_summary "$r/.git" main 12x 'whereami \u00B7 demo' 'a record' ''
out=$(run_hook startup "$r")
status=$?
check 'seen 12x: exit 0, nothing printed' '[ "$status" -eq 0 ] && [ -z "$out" ]'
for bad in 08 99999999999999999999; do
	put_summary "$r/.git" main "$bad" 'whereami \u00B7 demo' 'a record' ''
	out=$(run_hook startup "$r")
	status=$?
	check "seen $bad: exit 0, nothing printed" '[ "$status" -eq 0 ] && [ -z "$out" ]'
done
for bad in 'a \q b' 'a \u12' "a \\${tab}b"; do
	put_summary "$r/.git" main "$now" "$bad" 'a record' ''
	check "message $bad: nothing printed" '[ -z "$(run_hook startup "$r")" ]'
done
for f in seen message context agents detail; do
	put_summary "$r/.git" main "$now" 'whereami \u00B7 demo' 'a record' 'agents: 2 running' '\u000A  docs: a.md'
	case $f in
	seen) printf '%s\000\n' "$now" ;;
	*) printf 'before\000after\n.\n' ;;
	esac >"$r/.git/whereami/branches/main/$f"
	out=$(run_hook clear "$r")
	status=$?
	check "NUL in $f: exit 0, nothing printed" '[ "$status" -eq 0 ] && [ -z "$out" ]'
done
put_summary "$r/.git" main "$now" 'a \u0000 b' 'a record' ''
check 'escaped NUL' 'out=$(run_hook startup "$r"); has "$out" "a \\u0000 b" && printf "%s" "$out" | json_ok'
# The writer escapes every byte outside printable ASCII, so raw UTF-8 or a byte that is no UTF-8 is foreign, in any locale.
for loc in C C.UTF-8; do
	for kind in raw invalid; do
		put_summary "$r/.git" main "$now" 'whereami · demo' 'a record' ''
		case $kind in
		raw) printf '%s\n.\n' 'say \"hi\" ä' ;;
		invalid) printf 'before\377after\n.\n' ;;
		esac >"$r/.git/whereami/branches/main/message"
		out=$(export LC_ALL="$loc" && run_hook startup "$r")
		status=$?
		check "LC_ALL=$loc, $kind UTF-8 message: exit 0, nothing printed" '[ "$status" -eq 0 ] && [ -z "$out" ]'
	done
done
put_summary "$r/.git" main "$now" 'say \"hi\" \u00E4 \\ \/ \b\f\n\r\t' 'a record' ''
check 'every legal escape' 'out=$(run_hook startup "$r"); has "$out" "say \\\"hi\\\" \\u00E4" && printf "%s" "$out" | json_ok'

# Clock skew.
put_summary "$r/.git" main $((now + 300)) 'whereami \u00B7 demo' 'a record' ''
check 'seen in the future' 'has "$(run_hook startup "$r")" "(just now)"'

# Watched files: unchanged, touched after seen, deleted.
w=$tmp/watched
touch "$w"
age_file "$w" 2
put_summary "$r/.git" main "$now" 'whereami \u00B7 demo' 'a record' '' '' "$w"
age_file "$r/.git/whereami/branches/main/seen" 1
out=$(run_hook startup "$r")
check 'watch unchanged: no warning' 'has "$out" "whereami \\u00B7 demo" && ! has "$out" "files changed since"'
touch "$w"
check 'watch touched after seen' 'has "$(run_hook startup "$r")" "files changed since"'
rm "$w"
check 'watch deleted' 'has "$(run_hook startup "$r")" "files changed since"'

# Spec section 7's example from the files the mod writes for it (test/fixtures/summary.ts): dated heading, the
# lines under it, then the warning on a line of its own.
field() { sed -n "/^  $1:/{/',\$/!n;s/^.*'\(.*\)',\$/\1/p;}" "$ROOT/test/fixtures/summary.ts" | sed 's/\\\\/\\/g'; }
decoded() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).systemMessage)'; }
s_message=$(field message)
s_detail=$(field detail)
check 'summary fixture yields message and detail' '[ -n "$s_message" ] && [ -n "$s_detail" ]'
put_summary "$r/.git" main $((now - 7200)) "$s_message" 'a record' '' "$s_detail" "$tmp/no-such-doc"
s_at=$(date -d "@$((now - 7200))" +%H:%M 2>/dev/null || date -r "$((now - 7200))" +%H:%M)
s_expected="whereami · auth-refresh · build 4/7 recorded complete · as of $s_at (2 h ago)
  findings: 2 parked for the final review
  next: resume /superpowers:subagent-driven-development docs/superpowers/plans/2026-10-05-auth-refresh.md
  docs: docs/superpowers/specs/2026-10-05-auth-refresh-design.md, docs/superpowers/plans/2026-10-05-auth-refresh.md
  files changed since; open /whereami for a fresh look"
check 'spec example: decoded systemMessage' '[ "$(run_hook startup "$r" | decoded)" = "$s_expected" ]'

# Agents: only after clear or compact.
put_summary "$r/.git" main "$now" 'whereami \u00B7 demo' 'a record' 'agents: 2 running'
for s in clear compact; do
	check "agents on $s" 'out=$(run_hook "$s" "$r"); has "$out" "\\n  agents: 2 running\"," && has "$out" "a record\\n  agents: 2 running\"}" && printf "%s" "$out" | json_ok'
done
for s in startup resume; do
	check "no agents on $s" 'out=$(run_hook "$s" "$r"); has "$out" "whereami \\u00B7 demo" && ! has "$out" "agents:"'
done

# Headless.
check 'headless prints nothing' '[ -z "$(CLAUDE_CODE_SESSION_ATTENDED=0 && run_hook startup "$r")" ]'

# Cleanup: forgotten and expired notes go before printing, in files as src/notes.ts writes them.
c=$tmp/c
mkrepo "$c"
git -C "$c" worktree add -q -b feat/live "$tmp/cl"
C=$c/.git/whereami
# put_feature ID FINISHED NOTE_DAYS [BRANCH...]: feature ID's folder under $C, note.json NOTE_DAYS days old.
put_feature() {
	pf_dir=$C/features/$(keyof "$1")
	rm -rf "$pf_dir" && mkdir -p "$pf_dir" || return 1
	printf '{}\n' >"$pf_dir/note.json"
	age_file "$pf_dir/note.json" "$3"
	if [ -n "$2" ]; then printf '%s\n' "$2"; fi >"$pf_dir/finished"
	shift 3
	printf '%s\n' "$@" >"$pf_dir/branches"
}
# put_branch KEY FEATURE NAME SEEN: a branch summary under $C belonging to FEATURE, for branch (or folder) NAME.
put_branch() {
	put_summary "$c/.git" "$1" "$4" 'whereami \u00B7 c' 'a record' '' &&
		printf '%s\n' "$2" >"$C/branches/$1/feature" &&
		printf '%s\n' "$3" >"$C/branches/$1/name"
}
put_feature forgot '' 1 feat/live
put_branch feat%2Flive forgot feat/live "$now"
check 'cleanup setup: live summary prints' 'has "$(run_hook startup "$tmp/cl")" "whereami \\u00B7 c"'
touch "$C/features/forgot/forget"
put_feature a/b '' 1 feat/ab
put_branch feat%2Fab a/b feat/ab "$now"
touch "$C/features/a%2Fb/forget"
put_feature fin15 $((now - 15 * 86400)) 1 feat/live
put_branch feat%2Ffin15 fin15 feat/fin15 "$now"
put_feature fin13 $((now - 13 * 86400)) 1 feat/live
put_branch feat%2Ffin13 fin13 feat/fin13 "$now"
put_feature gone15 '' 15 feat/gone15
put_branch feat%2Fgone15 gone15 feat/gone15 "$now"
put_feature gone13 '' 13 feat/gone13
put_branch feat%2Fgone13 gone13 feat/gone13 "$now"
put_feature main15 '' 15 main
put_feature active30 '' 30 main feat/live
put_branch feat%2Fold other feat/old $((now - 15 * 86400))
put_branch main other main $((now - 15 * 86400))
put_branch "detached-$(keyof "$tmp/gone")" other "$tmp/gone" $((now - 15 * 86400))
put_branch "detached-$(keyof "$tmp/cl")" other "$tmp/cl" $((now - 15 * 86400))
put_feature .dot '' 1 feat/dot
put_branch feat%2Fdot .dot feat/dot "$now"
touch "$C/features/.dot/forget"
git -C "$c" branch feat/locked
put_feature locked '' 30 feat/locked
rm "$C/features/locked/branches" && mkdir "$C/features/locked/branches"
check 'unreadable branches setup: reading fails' '! cat "$C/features/locked/branches" >/dev/null 2>&1'
put_branch feat%2Flocked locked feat/locked "$now"
git -C "$c" branch detached-fix
put_branch detached-fix other detached-fix $((now - 15 * 86400))
put_feature notedir '' 1 main
rm "$C/features/notedir/note.json" && mkdir "$C/features/notedir/note.json"
touch "$C/features/notedir/note.json/old" && age_file "$C/features/notedir/note.json/old" 30
check 'note.json folder setup: find lists an old file' '[ -n "$(find "$C/features/notedir/note.json" -mtime +13)" ]'
put_feature nul '' 1 feat/live
printf '1\000\n' >"$C/features/nul/finished"
put_branch feat%2Fnul nul feat/nul "$now"
check 'NUL in finished setup: the NUL is there' 'od -An -tx1 "$C/features/nul/finished" | grep -q " 00"'
out=$(run_hook startup "$tmp/cl")
status=$?
check 'cleanup: exit 0, forgotten summary not printed' '[ "$status" -eq 0 ] && [ -z "$out" ]'
check 'forget: feature and its summary gone' '[ ! -e "$C/features/forgot" ] && [ ! -e "$C/branches/feat%2Flive" ]'
check 'forget a/b: feature and its summary gone' '[ ! -e "$C/features/a%2Fb" ] && [ ! -e "$C/branches/feat%2Fab" ]'
check 'finished 15 days ago: feature and summary gone' '[ ! -e "$C/features/fin15" ] && [ ! -e "$C/branches/feat%2Ffin15" ]'
check 'finished 13 days ago: feature and summary kept' '[ -f "$C/features/fin13/note.json" ] && [ -f "$C/branches/feat%2Ffin13/seen" ]'
check 'branches gone, note 15 days: feature and summary gone' '[ ! -e "$C/features/gone15" ] && [ ! -e "$C/branches/feat%2Fgone15" ]'
check 'branches gone, note 13 days: feature and summary kept' '[ -f "$C/features/gone13/note.json" ] && [ -f "$C/branches/feat%2Fgone13/seen" ]'
check 'only main, note 15 days: gone' '[ ! -e "$C/features/main15" ]'
check 'main and a live branch, note 30 days: kept' '[ -f "$C/features/active30/note.json" ]'
check 'summary of a deleted branch, seen 15 days ago: gone' '[ ! -e "$C/branches/feat%2Fold" ]'
check 'summary of an existing branch, seen 15 days ago: kept' '[ -f "$C/branches/main/seen" ]'
check 'detached summary of a deleted folder, seen 15 days ago: gone' '[ ! -e "$C/branches/detached-$(keyof "$tmp/gone")" ]'
check 'detached summary of an existing folder, seen 15 days ago: kept' '[ -f "$C/branches/detached-$(keyof "$tmp/cl")/seen" ]'
check 'forget .dot: feature and its summary gone' '[ ! -e "$C/features/.dot" ] && [ ! -e "$C/branches/feat%2Fdot" ]'
check 'unreadable branches, note 30 days: feature and summary kept' \
	'[ -f "$C/features/locked/note.json" ] && [ -f "$C/branches/feat%2Flocked/seen" ]'
check 'summary of an existing branch named detached-fix, seen 15 days ago: kept' '[ -f "$C/branches/detached-fix/seen" ]'
check 'note.json a fresh folder holding an old file, only main: kept' '[ -f "$C/features/notedir/note.json/old" ]'
check 'NUL in finished, note 1 day, live branch: feature and summary kept' \
	'[ -f "$C/features/nul/note.json" ] && [ -f "$C/branches/feat%2Fnul/seen" ]'
put_feature forgot '' 1 feat/live
touch "$C/features/forgot/forget"
check 'headless: cleanup runs' '(CLAUDE_CODE_SESSION_ATTENDED=0 && run_hook startup "$tmp/cl" >/dev/null) && [ ! -e "$C/features/forgot" ]'

# A scanner failure, even after partial output, is not proof of NUL-free content; cat still reads the file.
real_od=$(command -v od)
tool_path=$PATH
mkdir "$tmp/scanner-bin"
cat >"$tmp/scanner-bin/od" <<'SH'
#!/bin/sh
for arg do
	if [ "$arg" = "$SCAN_FILE" ]; then
		printf 'failed\n' >>"$SCAN_LOG"
		[ "$SCAN_MODE" = partial ] && printf ' 31 0a\n'
		exit 2
	fi
done
exec "$REAL_OD" "$@"
SH
chmod +x "$tmp/scanner-bin/od"
# The hook names the file by git's spelling of the common dir: links resolved (macOS /var is /private/var), a drive on Windows.
scan_file=$(git -C "$c" rev-parse --path-format=absolute --git-common-dir)/whereami/features/scan/finished
for scan_mode in empty partial; do
	put_feature scan '' 1 feat/live
	printf '1\000\n' >"$C/features/scan/finished"
	put_branch feat%2Fscan scan feat/scan "$now"
	put_feature scan-control 1 1 feat/live
	put_branch feat%2Fscan-control scan-control feat/scan-control "$now"
	check "scanner $scan_mode setup: fails while cat reads the NUL file" '(
		export PATH="$tmp/scanner-bin:$tool_path" REAL_OD="$real_od" SCAN_MODE="$scan_mode"
		export SCAN_FILE="$scan_file" SCAN_LOG="$tmp/scan.log"
		od -An -v -tx1 "$SCAN_FILE" >/dev/null
		[ "$?" -eq 2 ] && cat "$SCAN_FILE" >"$tmp/scan-copy" &&
			cmp "$SCAN_FILE" "$tmp/scan-copy" && "$REAL_OD" -An -v -tx1 "$tmp/scan-copy" | grep -q " 00"
	)'
	out=$(
		export PATH="$tmp/scanner-bin:$tool_path" REAL_OD="$real_od" SCAN_MODE="$scan_mode"
		export SCAN_FILE="$scan_file" SCAN_LOG="$tmp/scan.log"
		: >"$SCAN_LOG"
		run_hook startup "$tmp/cl"
	)
	status=$?
	check "scanner $scan_mode failure: feature and summary kept; valid expiry removed" \
		'[ "$status" -eq 0 ] && [ -s "$tmp/scan.log" ] &&
		[ -f "$C/features/scan/note.json" ] && [ -f "$C/branches/feat%2Fscan/seen" ] &&
		[ ! -e "$C/features/scan-control" ] && [ ! -e "$C/branches/feat%2Fscan-control" ]'
done

# A forgotten feature and its summary that cannot be removed: the summary stays on disk and is not printed.
put_feature stuck '' 1 feat/live
touch "$C/features/stuck/forget"
put_branch feat%2Flive stuck feat/live "$now"
chmod 555 "$C/features/stuck" "$C/branches/feat%2Flive"
if [ -w "$C/features/stuck" ] || [ -w "$C/branches/feat%2Flive" ]; then
	printf 'skip - removal fails: read-only folders stay writable for this user\n'
else
	out=$(run_hook startup "$tmp/cl")
	status=$?
	check 'removal fails: forgotten summary kept on disk and not printed' \
		'[ "$status" -eq 0 ] && [ -f "$C/features/stuck/forget" ] && [ -f "$C/branches/feat%2Flive/seen" ] && [ -z "$out" ]'
fi
chmod 755 "$C/features/stuck" "$C/branches/feat%2Flive"

# A summary whose owner cannot be read may belong to a forgotten feature: it stays on disk and nothing prints.
put_feature own '' 1 feat/live
put_branch feat%2Flive own feat/live "$now"
check 'unreadable owner setup: summary prints' 'has "$(run_hook startup "$tmp/cl")" "whereami \\u00B7 c"'
rm "$C/branches/feat%2Flive/feature" && mkdir "$C/branches/feat%2Flive/feature"
check 'unreadable owner setup: reading fails' '! cat "$C/branches/feat%2Flive/feature" >/dev/null 2>&1'
touch "$C/features/own/forget"
out=$(run_hook startup "$tmp/cl")
check 'unreadable owner, feature forgotten: feature gone, summary kept, nothing printed' \
	'[ ! -e "$C/features/own" ] && [ -f "$C/branches/feat%2Flive/seen" ] && [ -z "$out" ]'

# A detached worktree in a folder this user cannot search is hidden, not gone: its old summary stays.
git -C "$c" worktree add -q --detach "$tmp/hid/wt"
put_branch "detached-$(keyof "$tmp/hid/wt")" other "$tmp/hid/wt" $((now - 15 * 86400))
put_branch "detached-$(keyof "$tmp/gone")" other "$tmp/gone" $((now - 15 * 86400))
chmod 000 "$tmp/hid"
if [ -e "$tmp/hid/wt" ]; then
	printf 'skip - hidden worktree: a mode 000 folder stays searchable for this user\n'
else
	run_hook startup "$tmp/cl" >/dev/null
	check 'hidden detached worktree, seen 15 days ago: summary kept; a deleted one: gone' \
		'[ -f "$C/branches/detached-$(keyof "$tmp/hid/wt")/seen" ] && [ ! -e "$C/branches/detached-$(keyof "$tmp/gone")" ]'
fi
chmod 755 "$tmp/hid"

# A literal entry whose target cannot be resolved still exists in its accessible parent.
loop="$tmp/worktree loop [*?]"
ln -s "${loop##*/}" "$loop"
put_branch "detached-$(keyof "$loop")" other "$loop" $((now - 15 * 86400))
missing="$tmp/missing [*?]"
mkdir "$tmp/missing x"
put_branch "detached-$(keyof "$missing")" other "$missing" $((now - 15 * 86400))
check 'looping worktree setup: parent accessible, entry exists, target lookup fails' \
	'[ -d "$tmp" ] && [ -r "$tmp" ] && [ -x "$tmp" ] && [ -L "$loop" ] && [ ! -e "$loop" ]'
run_hook startup "$tmp/cl" >/dev/null
status=$?
check 'looping detached worktree: summary kept; literally missing folder: gone' \
	'[ "$status" -eq 0 ] && [ -f "$C/branches/detached-$(keyof "$loop")/seen" ] &&
	[ ! -e "$C/branches/detached-$(keyof "$missing")" ]'

# Even an accessible parent can fail during inspection; a failed listing is not an empty one.
real_find=$(command -v find)
mkdir "$tmp/find-bin" "$tmp/inspect" "$tmp/inspect-control"
cat >"$tmp/find-bin/find" <<'SH'
#!/bin/sh
case $1 in "$FIND_PARENT" | "$FIND_PARENT/"*)
	printf 'failed\n' >>"$FIND_LOG"
	exit 2
	;;
esac
exec "$REAL_FIND" "$@"
SH
chmod +x "$tmp/find-bin/find"
put_branch "detached-$(keyof "$tmp/inspect/wt")" other "$tmp/inspect/wt" $((now - 15 * 86400))
put_branch "detached-$(keyof "$tmp/inspect-control/wt")" other "$tmp/inspect-control/wt" $((now - 15 * 86400))
check 'inspection failure setup: accessible parent cannot be listed' '(
	export PATH="$tmp/find-bin:$tool_path" REAL_FIND="$real_find" FIND_PARENT="$tmp/inspect" FIND_LOG="$tmp/find.log"
	[ -d "$FIND_PARENT" ] && [ -r "$FIND_PARENT" ] && [ -x "$FIND_PARENT" ] || exit 1
	find "$FIND_PARENT" >/dev/null
	[ "$?" -eq 2 ]
)'
out=$(
	export PATH="$tmp/find-bin:$tool_path" REAL_FIND="$real_find" FIND_PARENT="$tmp/inspect" FIND_LOG="$tmp/find.log"
	: >"$FIND_LOG"
	run_hook startup "$tmp/cl"
)
status=$?
check 'failed detached-parent inspection: summary kept; inspected missing control: gone' \
	'[ "$status" -eq 0 ] && [ -f "$C/branches/detached-$(keyof "$tmp/inspect/wt")/seen" ] &&
	[ -s "$tmp/find.log" ] &&
	[ ! -e "$C/branches/detached-$(keyof "$tmp/inspect-control/wt")" ]'

# An individual summary symlink must not publish a forgotten feature or change its outside target.
put_feature linked '' 1 feat/live
put_branch feat%2Flive linked feat/live "$now"
check 'linked summary setup: the current summary prints before linking' \
	'has "$(run_hook startup "$tmp/cl")" "whereami \\u00B7 c"'
mv "$C/branches/feat%2Flive" "$tmp/linked-summary"
cp -R "$tmp/linked-summary" "$tmp/linked-snapshot"
ln -s "$tmp/linked-summary" "$C/branches/feat%2Flive"
touch "$C/features/linked/forget"
out=$(run_hook startup "$tmp/cl")
status=$?
check 'forgotten feature with linked current summary: feature gone, outside unchanged, exit 0, no output' \
	'[ "$status" -eq 0 ] && [ ! -e "$C/features/linked" ] && [ -L "$C/branches/feat%2Flive" ] &&
	diff -r "$tmp/linked-snapshot" "$tmp/linked-summary" && [ -z "$out" ]'

# A symlinked features folder: cleanup deletes nothing, there or in branches.
o=$tmp/outside
mkdir -p "$o/forgot"
touch "$o/forgot/forget"
printf 'keep\n' >"$o/keep.txt"
rm -rf "$C/features"
ln -s "$o" "$C/features"
put_branch feat%2Fold forgot feat/old $((now - 15 * 86400))
run_hook startup "$tmp/cl" >/dev/null
check 'symlinked features: nothing deleted' \
	'[ -f "$o/keep.txt" ] && [ -f "$o/forgot/forget" ] && [ -f "$C/branches/feat%2Fold/seen" ]'

# Git cannot read the refs (a broken packed-refs): an existing branch is unknown, not gone, so its note and summary stay.
c=$tmp/p
C=$c/.git/whereami
mkrepo "$c"
git -C "$c" branch feat/p
git -C "$c" pack-refs --all
printf 'not a ref\n' >>"$c/.git/packed-refs"
git -C "$c" show-ref --verify --quiet refs/heads/feat/p 2>/dev/null
status=$?
check 'broken refs setup: git cannot tell whether feat/p exists' '[ "$status" -gt 1 ]'
put_feature p '' 30 feat/p
put_branch feat%2Fp p feat/p $((now - 15 * 86400))
put_feature forgot '' 1 feat/p
touch "$C/features/forgot/forget"
run_hook startup "$c" >/dev/null
check 'broken refs: cleanup runs' '[ ! -e "$C/features/forgot" ]'
check 'broken refs, note 30 days, seen 15 days ago: feature and summary kept' \
	'[ -f "$C/features/p/note.json" ] && [ -f "$C/branches/feat%2Fp/seen" ]'

case "$(uname -s)" in
MINGW* | MSYS*)
	check 'Windows cwd' 'has "$(run_hook startup "$(cygpath -w "$r")")" "whereami \\u00B7 demo"'
	;;
esac

summary 'hook tests'
