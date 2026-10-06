#!/bin/sh
# Runs the end-to-end ways: every ways/*.sh, or those named by number or name (`run.sh 1 10`). Exits 1 on any failure.
cd "$(dirname "$0")" || exit 1
for t in tmux node; do
	command -v "$t" >/dev/null || {
		echo "e2e: $t is required" >&2
		exit 1
	}
done
E2E_RUN=$(date +%Y%m%d-%H%M%S)-$$
export E2E_RUN
passed=0
failed=0
[ $# -gt 0 ] || set -- ways/*.sh
for a; do
	case $a in
	ways/*.sh) w=$a ;;
	*)
		w=
		for f in ways/"$a"-*.sh ways/0"$a"-*.sh ways/"$a".sh; do
			if [ -f "$f" ]; then
				w=$f
				break
			fi
		done
		;;
	esac
	if [ -f "$w" ] && sh "$w"; then
		passed=$((passed + 1))
	else
		[ -f "$w" ] || echo "FAIL $a: no such way"
		failed=$((failed + 1))
	fi
done
echo "e2e: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
