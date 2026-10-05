#!/bin/sh
# SessionStart: cleans up, then prints this branch's saved whereami summary. Any failure prints nothing.

# keyof NAME: NAME's bytes, each outside [A-Za-z0-9._-] as %XX (uppercase); src/keys.ts keyOf agrees.
keyof() {
	printf '%s' "$1" | od -An -v -tx1 | awk '{
		for (i = 1; i <= NF; i++) {
			h = toupper($i)
			n = (index("0123456789ABCDEF", substr(h, 1, 1)) - 1) * 16 + index("0123456789ABCDEF", substr(h, 2, 1)) - 1
			if (n == 45 || n == 46 || n == 95 || (n >= 48 && n <= 57) || (n >= 65 && n <= 90) || (n >= 97 && n <= 122))
				printf "%c", n
			else
				printf "%%%s", h
		}
	}'
}

# Expiry and forgetting (Task 6).
cleanup() {
	:
}

# line FILE: prints FILE's first line when FILE is that line plus a "." line and the line is a JSON string body
# as src/keys.ts jsonString writes it: printable ASCII bytes but " and \ (the bracket: ] space ! #-Z ^-~ [),
# and only JSON's escapes. LC_ALL=C makes it byte by byte, whatever the inherited locale.
line() {
	[ "$(sed -n '$=' "$1")" = 2 ] && [ "$(sed -n 2p "$1")" = . ] &&
		sed -n 1p "$1" | LC_ALL=C grep -E '^([] !#-Z^-~[]|\\["\\/bfnrt]|\\u[0-9A-Fa-f]{4})*$'
}

input=$(cat)
source=$(printf '%s\n' "$input" | sed -n -E 's/.*"source"[[:space:]]*:[[:space:]]*"([a-z]*)".*/\1/p')
cwd=$(printf '%s\n' "$input" | sed -n -E 's/.*"cwd"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' |
	sed -E 's/\\(["\\/])/\1/g')
[ -n "$cwd" ] || exit 0
cd "$cwd" >/dev/null 2>&1 || exit 0

common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
W=$common/whereami
case $W in
/*/whereami | [A-Za-z]:/*/whereami) ;;
*) exit 0 ;;
esac

cleanup

[ "$CLAUDE_CODE_SESSION_ATTENDED" = 0 ] && exit 0

if branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null); then
	key=$(keyof "$branch")
else
	top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
	key=detached-$(keyof "$top")
fi

B=$W/branches/$key
# A NUL byte vanishes in $(…) and in grep's binary mode, so a file holding one is foreign.
for f in seen message context agents; do
	od -An -v -tx1 "$B/$f" 2>/dev/null | grep -q ' 00' && exit 0
done
seen=$(cat "$B/seen" 2>/dev/null) || exit 0
# Epoch seconds as sh arithmetic reads them: no leading zero (octal), at most 10 digits.
case $seen in
'' | *[!0-9]* | 0?* | ???????????*) exit 0 ;;
esac
message=$(line "$B/message" 2>/dev/null) || exit 0
context=$(line "$B/context" 2>/dev/null) || exit 0
agents=
if [ -s "$B/agents" ]; then
	agents=$(line "$B/agents" 2>/dev/null) || exit 0
fi

age=$(($(date +%s) - seen))
if [ "$age" -lt 60 ]; then
	ago='just now'
elif [ "$age" -lt 3600 ]; then
	ago="$((age / 60)) min ago"
elif [ "$age" -lt 172800 ]; then
	ago="$((age / 3600)) h ago"
else
	ago="$((age / 86400)) d ago"
fi
at=$(date -d "@$seen" +%H:%M 2>/dev/null || date -r "$seen" +%H:%M 2>/dev/null) || exit 0

warning=
if [ -f "$B/watch" ]; then
	while IFS= read -r p || [ -n "$p" ]; do
		[ -n "$p" ] || continue
		if [ ! -e "$p" ] || [ -n "$(find "$p" -newer "$B/seen" -print 2>/dev/null | head -n 1)" ]; then
			warning=' · files changed since; open /whereami for a fresh look'
			break
		fi
	done <"$B/watch"
fi

case $source in
clear | compact) [ -z "$agents" ] || agents="\\n  $agents" ;;
*) agents= ;;
esac

printf '{"systemMessage":"%s · as of %s (%s)%s%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s%s"}}\n' \
	"$message" "$at" "$ago" "$warning" "$agents" "$context" "$agents"
exit 0
