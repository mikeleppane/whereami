#!/bin/sh
# The real mod writes a branch summary in a headless session; the real hook prints it.
# check evaluates its CONDITION string, so single-quoted expansions are intended.
# shellcheck disable=SC2016
# shellcheck source=test/lib.sh
. "$(dirname "$0")/lib.sh"

case "$(uname -s)" in
MINGW* | MSYS*)
	echo 'agree tests: skipped on Windows (the pinned claude binary is not run there)'
	exit 0
	;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
SPEC=docs/superpowers/specs/2026-10-05-demo-design.md

# die WHAT: a repository could not be built, so no case may pass on another state.
die() {
	printf 'agree tests: setup failed: %s\n' "$1"
	exit 1
}

# on_branch DIR BRANCH: a repo whose BRANCH holds one commit adding the spec, after main's first commit.
on_branch() {
	if ! { mkrepo "$1" &&
		git -C "$1" checkout -q -b "$2" &&
		mkdir -p "$1/${SPEC%/*}" &&
		printf '# Demo\n' >"$1/$SPEC" &&
		git -C "$1" add "$SPEC" &&
		git -C "$1" commit -q -m spec; }; then
		die "branch $2"
	fi
}

# session DIR: one headless Claude Code session in DIR with this plugin, an empty home and no inherited settings.
session() {
	s_home=$(mktemp -d "$tmp/home.XXXXXX")
	(cd "$1" && env -i PATH="$PATH" HOME="$s_home" ${TMPDIR:+"TMPDIR=$TMPDIR"} DISABLE_AUTOUPDATER=1 \
		GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
		"$ROOT/node_modules/.bin/claude" -p --plugin-dir "$ROOT" "/exit" </dev/null >/dev/null 2>&1)
}

# printed DIR HEADING: a session in DIR, then the hook prints valid JSON whose message is HEADING, dated.
printed() {
	session "$1" || return 1
	p_out=$(run_hook startup "$1")
	printf '%s' "$p_out" | json_ok &&
		printf '%s' "$p_out" | HEADING=$2 node -e '
			const m = JSON.parse(require("fs").readFileSync(0, "utf8")).systemMessage
			process.exit(m.startsWith(`${process.env.HEADING} · as of `) ? 0 : 1)'
}

# silent DIR: a session in DIR, then the hook prints nothing and exits 0.
silent() {
	session "$1" || return 1
	s_out=$(run_hook startup "$1") && [ -z "$s_out" ]
}

on_branch "$tmp/repo" 'feat/ä-x'
check 'branch feat/ä-x' 'printed "$tmp/repo" "whereami · demo · design"'

# keyed DIR BRANCH: a session on BRANCH writes its summary under BRANCH's key in test/fixtures/keys.ts, the list the
# mod and the hook are each tested against, and the hook prints it.
keyed() {
	on_branch "$1" "$2"
	k_key=$(awk -F"'" -v n="$2" '$2 == n { print $4 }' "$ROOT/test/fixtures/keys.ts")
	[ -n "$k_key" ] && printed "$1" "whereami · demo · design" &&
		[ -f "$1/.git/whereami/branches/$k_key/seen" ]
}
check 'branch 100%' 'keyed "$tmp/percent" "100%"'
check 'branch fix/🐛' 'keyed "$tmp/emoji" "fix/🐛"'

on_branch "$tmp/base" feat/wt
git -C "$tmp/base" worktree add -q --detach "$tmp/my repo" feat/wt || die 'worktree in my repo'
check 'detached worktree in my repo' 'printed "$tmp/my repo" "whereami · demo · detached HEAD · design"'

# stale DIR: the hook in DIR warns that watched files changed since the summary.
stale() {
	case $(run_hook startup "$1") in *'files changed since'*) ;; *) return 1 ;; esac
}

# A Matt spec on its branch with no tickets: the first ticket written after the session makes the summary stale,
# whether its issues folder is not there yet or there and empty.
m=$tmp/matt
I=$m/.scratch/demo/issues
if ! { mkrepo "$m" &&
	git -C "$m" checkout -q -b feat/m &&
	mkdir -p "$m/.scratch/demo" &&
	printf '# Demo\n' >"$m/.scratch/demo/spec.md" &&
	git -C "$m" add .scratch/demo/spec.md &&
	git -C "$m" commit -q -m spec; }; then
	die 'matt spec'
fi
check 'a first ticket in a new issues folder makes the summary stale' \
	'printed "$m" "whereami · demo · design" && ! stale "$m" &&
		mkdir "$I" && printf "# Store\n" >"$I/01-store.md" && stale "$m"'
rm -f "$I/01-store.md" || die 'empty issues folder'
check 'a ticket added to an empty issues folder makes the summary stale' \
	'printed "$m" "whereami · demo · design" && ! stale "$m" &&
		printf "# Store\n" >"$I/01-store.md" && stale "$m"'

git -c init.defaultBranch=main init -q "$tmp/empty" || die 'repo with no commits'
# No commit holds a document, so no feature matches: nothing is shown (spec section 4 rule 7).
# The same repo once its branch commits the spec shows it, so the silence is not a session that never ran.
check 'no commits' 'silent "$tmp/empty" && on_branch "$tmp/empty" feat/e && printed "$tmp/empty" "whereami · demo · design"'

# The feature is gone (its note removed, the branch's spec commit undone): the next session leaves nothing to print.
on_branch "$tmp/lost" feat/lost
check 'a summary whose feature is gone is not printed after the next session' \
	'printed "$tmp/lost" "whereami · demo · design" &&
		rm -rf "$tmp/lost/.git/whereami/features" && git -C "$tmp/lost" reset -q --hard HEAD~1 &&
		silent "$tmp/lost"'

# The summary's message file links to the branch's spec: the writer stops there and the spec stays as it was.
on_branch "$tmp/linked" feat/link
L=$tmp/linked/.git/whereami/branches/feat%2Flink
mkdir -p "$L" || die 'linked message file'
ln -s "$tmp/linked/$SPEC" "$L/message" || die 'linked message file'
check 'a linked message file is not written through' \
	'session "$tmp/linked" && [ "$(cat "$L/name")" = feat/link ] &&
		[ "$(cat "$tmp/linked/$SPEC")" = "# Demo" ] && [ ! -e "$L/seen" ]'

summary 'agree tests'
