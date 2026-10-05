#!/bin/sh
# check evaluates its CONDITION string, so single-quoted expansions and variables used only there are intended.
# shellcheck disable=SC2016,SC2034
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
check 'normal: valid JSON' 'printf "%s" "$out" | json_ok'

# Linked worktree on a non-ASCII branch, in a folder with a space.
git -C "$r" worktree add -q -b 'feat/ä-x' "$tmp/my repo"
put_summary "$r/.git" 'feat%2F%C3%A4-x' "$now" 'whereami \u00B7 wt' 'a record' ''
check 'linked worktree' 'has "$(run_hook startup "$tmp/my repo")" "whereami \\u00B7 wt"'

# Where the session starts inside the repo, and how its cwd is written.
mkdir -p "$r/a/b" "$r/with space"
check 'subfolder cwd' 'has "$(run_hook startup "$r/a/b")" "whereami \\u00B7 demo"'
check 'cwd with a space' 'has "$(run_hook startup "$r/with space")" "whereami \\u00B7 demo"'
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
for f in seen message context agents; do
	put_summary "$r/.git" main "$now" 'whereami \u00B7 demo' 'a record' 'agents: 2 running'
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
put_summary "$r/.git" main "$now" 'whereami \u00B7 demo' 'a record' '' "$w"
age_file "$r/.git/whereami/branches/main/seen" 1
out=$(run_hook startup "$r")
check 'watch unchanged: no warning' 'has "$out" "whereami \\u00B7 demo" && ! has "$out" "files changed since"'
touch "$w"
check 'watch touched after seen' 'has "$(run_hook startup "$r")" "files changed since"'
rm "$w"
check 'watch deleted' 'has "$(run_hook startup "$r")" "files changed since"'

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

case "$(uname -s)" in
MINGW* | MSYS*)
	check 'Windows cwd' 'has "$(run_hook startup "$(cygpath -w "$r")")" "whereami \\u00B7 demo"'
	;;
esac

summary 'hook tests'
