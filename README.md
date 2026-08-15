# nabu-e2e

Playwright tests driving the self-hosted nabu stack in docker.

Every test carries a tier tag that decides what it runs against:

- `@stack` — the docker stack alone, no model in the path
- `@stubbed` — model and embeddings calls answered by a fake server replaying fixture files
- `@real` — the unmodified stack with real providers; needs API keys

The tag sits on the test and nothing derives it, so what a test needs is visible where the test is.

## Prerequisites

- docker with compose 2.24.4 or later — the harness refuses older versions
- node with npm
- sibling checkouts beside this repo: `nabu-frontend`, `nabu-storage`, and `nabu-self-hosted`; the 🔌 tier additionally builds `nabu-embeddings`, `nabu-prompts`, `chancery`, and `dragoman`

```sh
npm install && npx playwright install chromium
```

## Running

| Command | What it does |
| :--- | :--- |
| `make test` | CI run: fresh boot, `stack`+`stubbed` projects, full teardown |
| `make ux` | Playwright's UI runner against the running stack, booting one if needed |
| `make test-fast` | Headless run against the running stack, booting one if needed |
| `make up` / `make down` | Keep a stack running / remove it with its volumes and project files |
| `make fixtures` | Reload the fake server's fixtures after editing `fixtures/*.yaml` |
| `make real` | The 🔌 tier on `models.multi.yaml`; keys from your environment, else `.env.local` |

The stack publishes one port, `NABU_PORT` (default 8099), and runs under the compose project name `nabu-e2e`, so a dev stack running from `nabu-self-hosted` on its defaults is untouched.

Project files go to `nabu-e2e-projects` in the system temp directory, emptied at the start of every run and removed at the end. Tests that assert on disk read it directly, and each test seeds the project it needs over HTTP, so nothing has to be there beforehand.

> [!WARNING]
> `make ux` and `make test-fast` only check that the port answers; if a `@real` stack is still up from `make real`, run `make down` first or they will test against it.

## Selecting tests

Each Playwright project greps its tier tag. Run one tier, or narrow further by title:

```sh
NABU_E2E_REUSE=1 npx playwright test --grep @stack
```

## Environment

| Variable | Meaning |
| :--- | :--- |
| `NABU_E2E_TIER` | `stubbed` (default), `stack`, or `real` — `real` boots the stack without the e2e override |
| `NABU_PORT` | The stack's published port, default 8099 |
| `NABU_E2E_KEEP` | Skip teardown; the harness prints the removal command |
| `NABU_E2E_REUSE` | Run against an already-booted stack; no docker lifecycle at all |

## Next: writing tests

[docs/test-authoring.md](docs/test-authoring.md) covers adding tests: the per-test project fixture, fixture files for the fake model server and the matching rules that keep parallel runs safe, and how timing-sensitive behavior is driven. The component contracts live in [docs/specs/2026-08-08-01-claims-e2e-suite/](docs/specs/2026-08-08-01-claims-e2e-suite/).
