#!/bin/sh
# Way 5: Matt's script loop: `claude -p` implements ticket 01 with a commit; the next normal session starts with the
# feature and ticket 01 built here.
# shellcheck source=test/e2e/lib.sh
. "$(dirname "$0")/../lib.sh"

start_way 05-matt-script-loop
mkrepo
matt_demo

headless "$REPO" '/mattpocock-skills:implement .scratch/demo/issues/01-t.md'
wait_file "$REPO/.git/whereami/branches/feat%2Fdemo/message" 'build 1/2 \?$'

session "$REPO"
started startup 'whereami · demo · build 1/2 \? · as of '
expect_screen 'next: /mattpocock-skills:implement \.scratch/demo/issues/02-u\.md \(01 built here, still open\)'

end_way
