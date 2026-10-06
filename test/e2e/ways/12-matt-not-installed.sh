#!/bin/sh
# Way 12: Matt's documents with only Superpowers installed: /whereami names the missing skill, offers no Draft
# button, and its typed text holds no command.
# shellcheck source=test/e2e/lib.sh
. "$(dirname "$0")/../lib.sh"

start_way 12-matt-not-installed
PLUGINS=superpowers
mkrepo
matt_demo

session "$REPO"
send /whereami
expect_pane 'next: implement the next ready ticket \(not installed: mattpocock-skills:implement\) \[ Not this feature \]'
expect_screen 'next: implement the next ready ticket \(not installed:'
! pane | grep -q '\[ Draft' || fail 'the pane offers a Draft button'
! screen | grep -q 'next: /' || fail '/whereami printed a command'

end_way
