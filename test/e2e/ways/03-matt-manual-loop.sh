#!/bin/sh
# Way 3: Matt's manual loop: a typed /implement of ticket 01 and a commit, then /clear: the start counts 01 as built
# here, names ticket 02 next and never suggests 01 again.
# shellcheck source=test/e2e/lib.sh
. "$(dirname "$0")/../lib.sh"

start_way 03-matt-manual-loop
mkrepo
matt_demo
M=$REPO/.git/whereami/branches/feat%2Fdemo/message

session "$REPO"
say '/mattpocock-skills:implement .scratch/demo/issues/01-t.md'
wait_file "$M" 'build 1/2 \?$'

send /clear
started clear 'whereami · demo · build 1/2 \? · as of '
expect_screen 'next: /mattpocock-skills:implement \.scratch/demo/issues/02-u\.md \(01 built here, still open\)'
! screen | grep -q 'next: .*01-t\.md' || fail 'ticket 01 is suggested again'

end_way
