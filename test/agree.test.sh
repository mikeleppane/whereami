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

# printed DIR WHERE: a session in DIR, then the hook prints valid JSON whose message is the skeleton's for WHERE.
printed() {
	session "$1" || return 1
	p_out=$(run_hook startup "$1")
	printf '%s' "$p_out" | json_ok &&
		printf '%s' "$p_out" | WHERE=$2 node -e '
			const m = JSON.parse(require("fs").readFileSync(0, "utf8")).systemMessage
			process.exit(m.startsWith(`whereami · skeleton · ${process.env.WHERE} · as of `) ? 0 : 1)'
}

for b in 'feat/ä-x' '100%' 'fix/🐛'; do
	d=$tmp/repo-$(printf '%s' "$b" | od -An -tx1 | tr -d ' \n')
	on_branch "$d" "$b"
	check "branch $b" 'printed "$d" "$b"'
done

on_branch "$tmp/base" feat/wt
git -C "$tmp/base" worktree add -q --detach "$tmp/my repo" feat/wt || die 'worktree in my repo'
check 'detached worktree in my repo' 'printed "$tmp/my repo" "detached HEAD"'

git -c init.defaultBranch=main init -q "$tmp/empty" || die 'repo with no commits'
check 'no commits' 'printed "$tmp/empty" "no commits"'

# The summary's message file links to the branch's spec: the writer stops there and the spec stays as it was.
on_branch "$tmp/linked" feat/link
L=$tmp/linked/.git/whereami/branches/feat%2Flink
mkdir -p "$L" || die 'linked message file'
ln -s "$tmp/linked/$SPEC" "$L/message" || die 'linked message file'
check 'a linked message file is not written through' \
	'session "$tmp/linked" && [ "$(cat "$L/name")" = feat/link ] &&
		[ "$(cat "$tmp/linked/$SPEC")" = "# Demo" ] && [ ! -e "$L/seen" ]'

summary 'agree tests'
