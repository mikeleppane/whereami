# whereami never edits library files and never guesses a status

whereami only reads Superpowers' and Matt Pocock's files and runs read-only git. It writes nothing outside its own notes folder. It also never fills a gap with a guess: every status names its evidence (recorded in a library file, observed by whereami when a library skill started here, or related through commits only), and where none exists it says "unknown". Weaker evidence is always marked `?`. A confident wrong status is worse than "unknown", because the user acts on it after a break with nothing else to check it against.

## Consequences

- Some states stay honestly vague. A Superpowers ledger removed before every task was seen complete is "unknown", not "done". A Matt `/implement` that never updates its ticket shows "built here at 14:02, 2 commits, ticket still open". `implement-spec` mid-run shows "ticket statuses update at its end".
- The next action never drafts a command that would redo work whereami has seen done, recorded or committed; when it cannot tell, it says what it saw and drafts nothing.
- Features that would need writes are out of scope: marking tickets done, fixing ledgers, adding markers to plans. Contributors should not add them.
- When a library changes its file format, whereami shows "unsupported format" instead of a best-effort reading.

## Considered options

- **Write small markers into the libraries' files** (such as a ticket status or a plan header) to make tracking exact. Rejected: it changes what both libraries and their users see, and breaks when the libraries change.
- **Assume the obvious** (a missing ledger means not started; open tickets mean not built). Rejected: both assumptions were shown false in our own experiments.
