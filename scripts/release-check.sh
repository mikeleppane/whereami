#!/bin/sh

fail() {
	printf 'release-check: %s\n' "$1" >&2
	exit 1
}

passed() {
	printf 'release-check: step %s ok\n' "$1"
}

if ! status=$(git status --porcelain); then
	fail 'step 1 failed: could not read git status'
fi
if [ -n "$status" ]; then
	fail 'step 1 failed: working tree is not clean'
fi
passed 1

if make check; then
	:
else
	fail 'step 2 failed: make check did not pass'
fi
passed 2

if ! changelog_heading=$(sed -n '/^## /{p;q;}' CHANGELOG.md); then
	fail 'step 3 failed: could not read CHANGELOG.md'
fi
case $changelog_heading in
'## '*) ;;
*) fail 'step 3 failed: CHANGELOG.md has no top release heading' ;;
esac
changelog_version=$(printf '%s\n' "$changelog_heading" | sed -n 's/^## \([^[:space:]]*\).*/\1/p')
if [ -z "$changelog_version" ]; then
	fail 'step 3 failed: CHANGELOG.md top heading has no version'
fi

if ! plugin_version=$(node --input-type=module -e '
import { readFileSync } from "node:fs";
const plugin = JSON.parse(readFileSync(".claude-plugin/plugin.json", "utf8"));
if (typeof plugin.version !== "string" || plugin.version.length === 0) process.exit(1);
process.stdout.write(plugin.version);
' 2>/dev/null); then
	fail 'step 3 failed: could not read plugin.json version'
fi
if [ "$plugin_version" != "$changelog_version" ]; then
	fail "step 3 failed: plugin.json version ($plugin_version) does not match CHANGELOG.md top heading ($changelog_version)"
fi
case $changelog_heading in
*'(unreleased)'*) fail 'step 3 failed: CHANGELOG.md top heading is marked (unreleased)' ;;
esac
version=$plugin_version
passed 3

if git rev-parse -q --verify "refs/tags/v$version" >/dev/null 2>&1; then
	fail "step 4 failed: tag v$version already exists"
fi
passed 4

if ! command -v gh >/dev/null 2>&1; then
	fail 'step 5 failed: gh is not installed'
fi
if ! gh auth status >/dev/null 2>&1; then
	fail 'step 5 failed: gh is not authenticated'
fi
if ! head=$(git rev-parse HEAD 2>/dev/null); then
	fail 'step 5 failed: could not resolve HEAD'
fi
if ! runs=$(gh run list --workflow ci.yml --commit "$head" --json databaseId,status,conclusion --limit 1 2>/dev/null); then
	fail "step 5 failed: could not list CI runs for commit $head"
fi
if ! run_id=$(printf '%s\n' "$runs" | node --input-type=module -e '
import { readFileSync } from "node:fs";
const runs = JSON.parse(readFileSync(0, "utf8"));
if (!Array.isArray(runs) || runs.length !== 1) process.exit(1);
const run = runs[0];
if (run.status !== "completed" || run.conclusion !== "success" || run.databaseId == null) process.exit(1);
process.stdout.write(String(run.databaseId));
' 2>/dev/null); then
	fail "step 5 failed: no completed successful CI run for commit $head"
fi
if ! jobs=$(gh run view "$run_id" --json jobs 2>/dev/null); then
	fail "step 5 failed: could not read jobs for CI run $run_id"
fi
if ! printf '%s\n' "$jobs" | node --input-type=module -e '
import { readFileSync } from "node:fs";
const data = JSON.parse(readFileSync(0, "utf8"));
const required = ["check (ubuntu-latest)", "check (macos-latest)", "windows", "e2e", "secrets"];
if (!Array.isArray(data.jobs) || !required.every((name) =>
	data.jobs.some((job) => job.name === name && job.conclusion === "success"))) process.exit(1);
' 2>/dev/null; then
	fail "step 5 failed: CI run $run_id is missing required successful jobs"
fi
passed 5

printf 'release-check: ok %s\n' "$version"
