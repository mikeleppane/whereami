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

# readf FILE: prints FILE's content when FILE is a regular file, not a link, that reads in full and holds no NUL.
# Validate the complete hex dump before cat: command substitution can discard raw NUL bytes.
readf() {
	{ [ -f "$1" ] && [ ! -L "$1" ]; } || return 1
	bytes=$(od -An -v -tx1 "$1" 2>/dev/null) || return 1
	case $bytes in *" 00"*) return 1 ;; esac
	cat "$1" 2>/dev/null
}

# epoch VALUE: VALUE is epoch seconds as sh arithmetic reads them: no leading zero (octal), at most 10 digits.
epoch() {
	case $1 in
	'' | *[!0-9]* | 0?* | ???????????*) return 1 ;;
	esac
}

# safe_rm PATH: rm -rf PATH, only when it is below $W.
safe_rm() {
	case "$1" in "$W"/?*) rm -rf -- "$1" ;; esac
}

# has_branch NAME: 0 when refs/heads/NAME exists, 1 when git says it does not, 2 when git cannot tell.
has_branch() {
	git show-ref --verify --quiet "refs/heads/$1"
	case $? in 0) return 0 ;; 1) return 1 ;; *) return 2 ;; esac
}

# expired F: feature folder F finished over 14 days ago, or its note.json is over 14 days old and none of its
# branches exists or its only branch is the default one. Only proof expires it: a failed read, a foreign value, a
# note.json that is no regular file or a git error keeps it.
expired() {
	fin=$(readf "$1/finished") || return 1
	if [ -n "$fin" ]; then
		epoch "$fin" || return 1
		[ $((now - fin)) -gt 1209600 ] && return 0
	fi
	old=$(find "$1/note.json" -prune -type f -mtime +13 2>/dev/null) && [ -n "$old" ] || return 1
	bs=$(readf "$1/branches") || return 1
	live='' other=''
	while IFS= read -r b; do
		[ -n "$b" ] || continue
		[ "$b" = "$default" ] || other=1
		has_branch "$b"
		case $? in 0) live=1 ;; 1) ;; *) return 1 ;; esac
	done <<EOF
$bs
EOF
	[ -z "$live" ] || { [ -n "$default" ] && [ -z "$other" ]; }
}

# stale K: branch summary K was seen over 14 days ago and its branch is gone; for a detached HEAD, whose key is
# detached-<key of its folder> (a branch named detached-x is keyed detached-x), its folder is gone. A folder is
# gone only after a successful parent inspection finds no literal entry, without following its target.
stale() {
	at=$(readf "$1/seen") && epoch "$at" && [ $((now - at)) -gt 1209600 ] || return 1
	name=$(readf "$1/name") || return 1
	if [ "${1##*/}" = "detached-$(keyof "$name")" ]; then
		p=${name%/*}
		[ -d "$p" ] && [ -r "$p" ] && [ -x "$p" ] || return 1
		leaf=$(printf '%s\n' "${name##*/}" | sed 's/[][\\*?]/\\&/g') || return 1
		entry=$(find "$p/." ! -name . -prune -name "$leaf" -print 2>/dev/null) || return 1
		[ -z "$entry" ]
	else
		has_branch "$name"
		[ $? -eq 1 ]
	fi
}

# cleanup: deletes forgotten and expired notes with their branch summaries, then stale summaries (spec section 3).
# Never follows a link: a linked whereami, features or branches folder stops it; a linked note or summary is skipped.
# Fails when it stops or a removal fails, so a forgotten feature's summary is never printed.
cleanup() {
	{ [ -L "$W" ] || [ -L "$W/features" ] || [ -L "$W/branches" ]; } && return 1
	ok=0
	now=$(date +%s)
	if d=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null); then
		default=${d#origin/}
	elif git show-ref --verify --quiet refs/heads/main; then
		default=main
	elif git show-ref --verify --quiet refs/heads/master; then
		default=master
	else
		default=
	fi
	# Keys never hold a / or a space, so " /KEY/" marks one deleted feature folder.
	gone=
	# keyOf keeps a leading ".", so dot folders are notes too.
	for f in "$W"/features/* "$W"/features/.[!.]* "$W"/features/..?*; do
		{ [ -d "$f" ] && [ ! -L "$f" ]; } || continue
		if [ -e "$f/forget" ] || expired "$f"; then
			if safe_rm "$f"; then gone="$gone /${f##*/}/"; else ok=1; fi
		fi
	done
	for k in "$W"/branches/*; do
		{ [ -d "$k" ] && [ ! -L "$k" ]; } || continue
		# An owner that cannot be read may be a forgotten feature: keep its summary and fail. A summary with no
		# feature file has no owner.
		owner=
		if [ -e "$k/feature" ] || [ -L "$k/feature" ]; then
			owner=$(readf "$k/feature") || {
				ok=1
				continue
			}
		fi
		case $gone in
		*/"$(keyof "$owner")"/*) safe_rm "$k" || ok=1 ;;
		*) if stale "$k"; then safe_rm "$k" || ok=1; fi ;;
		esac
	done
	return $ok
}

# line FILE: prints FILE's first line when readf reads FILE, FILE is that line plus a "." line and the line is a JSON
# string body as src/keys.ts jsonString writes it: printable ASCII bytes but " and \ (the bracket: ] space ! #-Z ^-~ [),
# and only JSON's escapes. LC_ALL=C makes it byte by byte, whatever the inherited locale.
line() {
	readf "$1" >/dev/null && [ "$(sed -n '$=' "$1")" = 2 ] && [ "$(sed -n 2p "$1")" = . ] &&
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

cleanup 2>/dev/null || exit 0

[ "$CLAUDE_CODE_SESSION_ATTENDED" = 0 ] && exit 0

if branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null); then
	key=$(keyof "$branch")
else
	top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
	key=detached-$(keyof "$top")
fi

B=$W/branches/$key
[ -L "$B" ] && exit 0
seen=$(readf "$B/seen") && epoch "$seen" || exit 0
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
