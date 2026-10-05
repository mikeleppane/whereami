SHELL := /bin/sh
BIN := $(CURDIR)/node_modules/.bin
export PATH := $(CURDIR)/node_modules/.bin:$(PATH)
export DISABLE_AUTOUPDATER := 1
.DEFAULT_GOAL := help
SH_FILES = $(wildcard hooks/*.sh scripts/*.sh test/*.sh test/e2e/*.sh test/e2e/ways/*.sh)
.PHONY: help types fmt fmt-check lint typecheck test check e2e release-check tools

node_modules/.package-lock.json: package-lock.json
	npm ci

help: ## show this help
	@grep -E '^[a-z][a-z0-9-]*:.*## ' Makefile | sed 's/:.*## /\t/'

tools: ## check shell tooling is installed
	@command -v shellcheck >/dev/null && command -v shfmt >/dev/null || { echo "install shellcheck and shfmt (apt install shellcheck shfmt, or brew install shellcheck shfmt)" >&2; exit 1; }

types: node_modules/.package-lock.json ## generate Claude Code type declarations
	@[ -f .claude-plugin/types/claude-code/index.d.ts ] || $(BIN)/claude -p --plugin-dir . "/exit" >/dev/null
	@test -f .claude-plugin/types/claude-code/index.d.ts

fmt: node_modules/.package-lock.json tools ## format all supported files
	$(BIN)/biome check --write .
	shfmt -w -p -i 0 $(SH_FILES)
	$(BIN)/markdownlint-cli2 --fix

fmt-check: node_modules/.package-lock.json tools ## check formatting
	$(BIN)/biome format .
	shfmt -d -p -i 0 $(SH_FILES)

lint: node_modules/.package-lock.json tools ## lint and validate the plugin
	$(BIN)/biome lint .
	shellcheck -s sh $(SH_FILES)
	$(BIN)/markdownlint-cli2
	$(BIN)/claude plugin validate .

typecheck: node_modules/.package-lock.json types ## check TypeScript types
	$(BIN)/tsc -p .

test: node_modules/.package-lock.json types ## run plugin and shell tests
	$(BIN)/claude plugin test .
	for t in test/*.test.sh; do sh "$$t" || exit 1; done

check: fmt-check lint typecheck test ## run every local gate

e2e: node_modules/.package-lock.json ## run end-to-end scenarios
	sh test/e2e/run.sh $(WAYS)

release-check: node_modules/.package-lock.json ## check release readiness
	sh scripts/release-check.sh
