export NABU_PORT ?= 8099

.PHONY: help test up ensure-up test-fast ux down fixtures real

help:
	@echo "make test       - CI run: fresh boot, stack+stubbed projects, full teardown"
	@echo "make up         - boot the stubbed stack and leave it running (walking skeleton as probe)"
	@echo "make test-fast  - run stack+stubbed against the running stack (boots one if needed)"
	@echo "make ux         - Playwright UI runner against the running stack (boots one if needed)"
	@echo "make fixtures   - reload fake-model-server fixtures after editing fixtures/*.yaml"
	@echo "make real       - real tier: unmodified stack, models.multi.yaml (keys from .env.local)"
	@echo "make down       - tear the stack down, volumes included"

# Fresh boot, full run, teardown — the one command for CI.
test:
	npm test

up:
	NABU_E2E_KEEP=1 npx playwright test tests/walking-skeleton.spec.ts --project stubbed

# A real-tier stack answers /health too; test-fast/ux assume the stubbed one.
ensure-up:
	@curl -sf http://localhost:$(NABU_PORT)/health >/dev/null 2>&1 || $(MAKE) up

test-fast: ensure-up
	NABU_E2E_REUSE=1 npx playwright test --project stack --project stubbed

ux: ensure-up
	NABU_E2E_REUSE=1 npx playwright test --ui

fixtures:
	./scripts/reload-fixtures.sh

down:
	./scripts/compose.sh down -v --remove-orphans

# Keys already in the environment win; if any is missing, .env.local
# supplies them all.
real:
	@set -a; { [ -n "$$OPENAI_API_KEY" ] && [ -n "$$GEMINI_API_KEY" ] && [ -n "$$ANTHROPIC_API_KEY" ]; } || . ./.env.local; set +a; \
	NABU_E2E_TIER=real \
	CHANCERY_REPO=$(abspath ../../chancery) \
	DRAGOMAN_REPO=$(abspath ../../dragoman) \
	npx playwright test --project real
