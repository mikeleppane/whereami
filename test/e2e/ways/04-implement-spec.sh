#!/bin/sh
# Way 4: Matt's /implement-spec with its agent still running: the band shows a weak build and the agent, nothing is
# drafted that would redo the build, and after /clear the start says the agent from before the clear still runs.
# poll evaluates its condition string, so its single-quoted expansions are intended.
# shellcheck disable=SC2016
# shellcheck source=test/e2e/lib.sh
. "$(dirname "$0")/../lib.sh"

start_way 04-implement-spec
mkrepo
matt_demo
B=$REPO/.git/whereami/branches/feat%2Fdemo

session "$REPO"
say '/mattpocock-skills:implement-spec .scratch/demo/spec.md'
wait_file "$B/agents" '^1 agents from before the clear are still running$'
expect_screen 'whereami · demo · build 0/2 \? · 1 agents running( |$)'
! grep -q 'next: /' "$B/detail" || fail "the summary drafts a command: $(cat "$B/detail")"

send /clear
started clear 'whereami · demo · build 0/2 \? · as of '
expect_screen '^ *1 agents from before the clear are still running *$'

# The agent still runs, so /exit asks first; stopping it ends the session.
send /exit
expect_screen 'Exit and stop tasks'
tm send-keys -t way Enter
poll 30 '[ "$(tm display-message -p -t way "#{pane_dead}")" = 1 ]' || fail 'stopping the agent did not end the session'

end_way
