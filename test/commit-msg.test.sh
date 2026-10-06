#!/bin/sh

failures=0
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM
message_file=$tmp_dir/message
long_subject=$(awk 'BEGIN { for (i = 0; i < 61; i++) printf "a" }')

check() {
	name=$1
	expected=$2
	shift 2
	"$@" >"$message_file"
	sh scripts/check-commit-msg.sh "$message_file"
	actual=$?
	if [ "$actual" -eq "$expected" ]; then
		printf 'ok - %s\n' "$name"
	else
		printf 'not ok - %s (expected exit %s, got %s)\n' "$name" "$expected" "$actual"
		failures=$((failures + 1))
	fi
}

check 'valid scoped subject passes' 0 printf '%s\n' 'feat(hook): print the saved summary'
check 'missing scope fails' 1 printf '%s\n' 'feat: no scope'
check 'uppercase subject fails' 1 printf '%s\n' 'feat(hook): Capital'
check '73-character subject fails' 1 printf '%s\n' "feat(hook): $long_subject"
check 'trailing period fails' 1 printf '%s\n' 'fix(mod): trailing.'
check 'co-author attribution fails' 1 printf '%s\n' 'feat(hook): add summary' '' 'Co-Authored-By: x'
check 'robot attribution fails' 1 printf '%s\n' 'feat(hook): add summary' '' '🤖'
check 'merge subject passes' 0 printf '%s\n' "Merge branch 'x'"
check 'scissors commentary is ignored' 0 printf '%s\n' 'feat(hook): add summary' '' '# ------------------------ >8' 'Co-Authored-By: x'

printf '%s commit-message checks failed\n' "$failures"
[ "$failures" -eq 0 ]
