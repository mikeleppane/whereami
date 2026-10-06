# whereami

A progress and recovery companion for people who build with Superpowers, Matt Pocock's skills, or both.
It answers "where was I?" after a break, a restart or a `/clear`.

## Work and its documents

**Library**:
A skill collection whose files whereami reads: Superpowers or Matt Pocock's skills.
_Avoid_: framework, toolkit

**Feature**:
One piece of work followed from its first document to its merge, possibly across several branches and both libraries.
_Avoid_: project, branch, epic

**Spec**:
The document that says what a feature should do: a Superpowers design document or a Matt `spec.md`.
_Avoid_: design doc, PRD

**Plan**:
A Superpowers document that splits a feature into numbered tasks.
_Avoid_: implementation plan, roadmap

**Task**:
One numbered step of a plan.
_Avoid_: step, item, ticket

**Ticket**:
One Matt Pocock issue file belonging to a feature, describing work to build. Counted apart from decisions.
_Avoid_: issue, task, story

**Map**:
A Matt Pocock wayfinder file charting a large, unclear effort as a set of decisions to make before any spec exists.
_Avoid_: roadmap, plan

**Decision**:
One ticket of a map: a question to resolve, not work to build.
_Avoid_: task, research item

**Ledger**:
The progress file Superpowers writes while it builds a plan, and deletes after its final review.
_Avoid_: progress log, journal

**Blocked**:
Needing a human before work can go on, such as a ticket waiting for information.
_Avoid_: stuck, parked

**Parked finding**:
A review finding that Superpowers set aside with a ruling so the build could go on; the final review sees it. Not a stop.
_Avoid_: blocker, parked task

**Waiting**:
Queued behind tasks or tickets that are not yet complete. Normal, not a problem.
_Avoid_: blocked, pending

**Frontier**:
The open tickets or decisions whose blockers are all complete and that nobody has started: the ones ready now.
_Avoid_: ready queue, next tickets

**Agent**:
A background helper Claude Code is running in the session, whatever feature it serves.
_Avoid_: worker, subagent (in user-facing text)

## What whereami knows

**Evidence**:
The file line or commit that a status rests on, with its strength.
_Avoid_: proof, source

**Recorded**:
Evidence written by a library into its own files.

**Observed**:
Evidence that whereami itself saw a library skill start on this work, plus the commits made after it; shown with a `?`.
_Avoid_: tracked, detected

**Related**:
Evidence inferred only from commits; shown with a `?`.
_Avoid_: inferred, guessed

**Phase**:
How far a feature has come: design, plan, build, review, done or merged, or unknown.
_Avoid_: stage, status

**Note**:
whereami's own record of a feature, kept outside the repository's tracked files.
_Avoid_: cache, state file

**Summary**:
The short text shown when a session starts, as it stood when last written.
_Avoid_: recap, report

## What the user sees

**Band**:
The one line above the prompt naming the feature, its phase and its count.
_Avoid_: status bar, banner

**View**:
The `/whereami` pane with the feature's documents, tasks or tickets, evidence and next action.
_Avoid_: dashboard, panel

**Next action**:
The one suggestion whereami makes for what to do now; when it is a command, whereami drafts it into the prompt for the user to send.
_Avoid_: recommendation, hint

**Pop-up**:
A brief message raised once when a feature reaches a moment worth knowing.
_Avoid_: toast, notification, alert
