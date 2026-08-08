# Test suite

The test suite is the Playwright project of the [claims e2e suite](spec.md): it turns the claims in [frontend-behavior-claims.md](../../../../frontend-behavior-claims.md) into tagged tests across three run tiers and reports, per claim, whether its tests passed.

## Contract

The suite is a Node project in `nabu-e2e` with its own `package.json`, installed and run with npm. The runner is `@playwright/test`, chromium only.

These are the commands a developer runs:

```sh
npm test                              # default run: the stack and stubbed projects
npx playwright test --grep @E1        # exactly the tests behind checkbox E1
npx playwright test --project real    # the real tier; needs API keys
```

### Projects

The claims file marks every claim with a tier emoji, and that marker is the sole source of truth for which Playwright project a test belongs to:

- `stack` — the 💾 claims: the docker stack alone, no model in the path.
- `stubbed` — the 🎭 claims: model and embeddings calls answered by [fake-model-server](fake-model-server.md) fixtures.
- `real` — the 🔌 claims plus the smoke test pinned in [spec.md's "What must not change"](spec.md#what-must-not-change): the unmodified compose file, real providers.

`npm test` runs `stack` and `stubbed`; `real` runs only on explicit `--project real` because it needs provider API keys, supplied as described in [stack-harness](stack-harness.md). Selecting a Playwright project does not select the harness mode — those are two switches — so every test in the `real` project starts by checking the tier the harness recorded ([stack-harness](stack-harness.md), "Booted tier") and fails immediately, naming the fix, when the stack booted in override mode; the pinned smoke test would otherwise "verify" the unmodified stack against a modified one.

### Folders and tags

Test files live in one folder per claims-file section, named after the section; files inside are free-form:

| Folder | Claims section | Labels |
| --- | --- | --- |
| `documents/` | D — Documents and editing | `@D1`–`@D10` |
| `projection/` | P — Projection to SQL | `@P1`–`@P4` |
| `embeddings/` | E — Embeddings | `@E1`–`@E6` |
| `search/` | S — Semantic search | `@S1`–`@S12` |
| `grounded/` | G — Grounded answers | `@G1`–`@G7` |
| `consensus/` | C — Consensus | `@C1`–`@C7` |
| `agent-loop/` | L — The agent loop | `@L1`–`@L9` |
| `tools/` | T — Tools | `@T1`–`@T9` |
| `sync/` | Y — Sync and persistence | `@Y1`–`@Y8` |

Folders group by topic, not by tier: `search/` holds the tests of eleven stubbed claims and the one real one, because project membership comes from each claim's tier marker, not from the file's location.

Every test carries its claim label as a Playwright tag, `@D1` through `@Y8`. One claim may be covered by several tests, and one test may serve several claims by carrying several tags. The tags are the entire claim-to-test mapping — there is no mapping file to drift — so `--grep @E1` runs exactly the tests behind checkbox E1. Projects plus grep tags are Playwright's own selection mechanism; [playwright.dev/docs/test-projects](https://playwright.dev/docs/test-projects) and [playwright.dev/docs/test-annotations](https://playwright.dev/docs/test-annotations) are the references to follow.

### Per-test isolation

The stack boots once per run — the docker boot is the expensive part — and every test gets a fresh project inside it.

The corpus itself is checked in at `nabu-e2e/base-project/`, owned by this component: the [seeder](seeder.md) loads it as the boot-time base project, and per-test projects are seeded from the same directory — plus per-test marker documents where a fixture needs them — so the two seeding paths cannot drift.

A worker fixture creates a project by choosing a fresh UUID and seeding files through the same storage API the app itself uses, reached through the proxy as `POST /api/commands/{projectId}` — the proxy strips the `/api` prefix on the way to storage (`nabu-self-hosted/Caddyfile:38-40`) — with a `Command` of shape `{action: WriteFile | DeleteFile | RenameFile | SyncMeta, path?, newPath?, content?, fileCount?}` (`nabu-frontend/app/lib/server/sync/commands.ts:17-44`, `nabu-frontend/app/lib/server/sync/types.ts:1-9`). No create-project call exists or is needed: storage's `Write` runs `EnsureProjectDir` before writing, so the first `WriteFile` to a new id creates the project (`nabu-storage/internal/domain/files/files.go:23-40`). This is exactly how the stack's own welcome-seed creates its project — a single `WriteFile` POST of `welcome.md` to a freshly generated UUID (`nabu-self-hosted/seed/main.go:86-111`).

The app's boot expects a `SyncMeta` command carrying `fileCount` followed by that many `WriteFile` commands over the websocket (`nabu-frontend/app/routes/project.tsx:248-260`), and its loading gate then blocks up to 30s until `settings.hidden.md` and `preferences.md` exist (claim Y5; `REQUIRED_FILES` at `nabu-frontend/app/lib/files/store.ts:38`, `waitForRequiredFiles` at `store.ts:290-306`, names at `app/lib/files/filename.ts:1-2`). The seeded corpus does not need to include those two files: on websocket connect, storage seeds them from embedded templates into any existing project before sending the initial file list (`nabu-storage/internal/domain/files/seed.go:34-48`, `nabu-storage/internal/api/websocket/handler.go:136-158`, templates at `internal/domain/files/templates/`). Storage skips seeding when the project directory does not exist (`seed.go:35-37`), so the fixture must land at least one `WriteFile` before the page navigates, or the gate times out.

Boot also fires model traffic beyond embeddings: the loading gate awaits topic assignment (`nabu-frontend/app/routes/project.tsx:286-304`), which posts `/topic-assigner` per seeded file (`nabu-frontend/app/lib/corpus/sync-topics.ts:108`, `classify.ts:40-41`), and description sync can post `/corpus-describer` for corpora past 500 words (`nabu-frontend/app/lib/corpus/describe.ts:6-7`). The suite ships a standing boot fixture set beside `base-project/` answering those endpoints for the corpus it seeds, so every boot completes cleanly instead of leaning on corpus sync's error swallowing (`sync-topics.ts:131-132`) and littering the journal with unmatched entries — the fake's failure marker.

### Parallel safety

Playwright workers run in parallel, each driving its own project id. The fake's request journal is filtered by the `X-Project-ID` header — the [fake-model-server](fake-model-server.md) contract — and the suite's rule is: a test may only assert on journal entries carrying its own project id. The journal helper handed to a test is pre-scoped to that test's project, so the rule holds by construction rather than by discipline.

### Determinism

The frontend caches LLM responses in IndexedDB: `callLlm` returns a cached `Block[]` for a repeated endpoint-plus-body key, skipping the cache only for endpoints containing `/qual-coder` or `/semantic-filter` and for calls with streaming callbacks (`nabu-frontend/app/lib/agent/client/fetch.ts:158-163,198-228`). A cache hit would let a test pass without the fake ever seeing the request, so the journal would be empty for a call that "happened".

The app reads debug flags from the localStorage key `nabu-debug-options` at mount (`nabu-frontend/app/routes/project.tsx:108-118`); the available toggles, including `skipCache` (bypass the LLM response cache) and `persistToServer`, are declared in `nabu-frontend/app/ui/components/editor/debug-config.tsx:16-72`. The suite sets `skipCache: true` through a Playwright init script before every page load. The one exception is S7, which claims the caching behavior itself and therefore runs with the cache on.

E5 and E6 claim what happens when `VITE_EMBEDDINGS_DIMENSIONS` or `VITE_EMBEDDINGS_MODEL` *changes*, and both are baked into the bundle at build time — unreachable by a suite that boots one image per run. Those two tests set the [frontend-test-hook](frontend-test-hook.md)'s env override before a second page load against the same project: embed at one width, reload with the override, and observe detection (E5) or its documented absence (E6).

### Timing

Two debounces in the claims are in-page timers, so `page.clock` can drive them: the per-path write debounce of 500ms behind Y2/Y3 (`createScopedDebounce(500)` at `nabu-frontend/app/lib/files/store.ts:62`, used by `persistWrite` at `store.ts:105-112`) and the 5s embeddings sync debounce behind E1 (`nabu-frontend/app/lib/embeddings/sync.ts:189-190`, `EMBEDDING_SYNC_DEBOUNCE = 5000` at `app/lib/embeddings/constants.ts:5`). A test installs the fake clock, edits, advances time, and asserts the request — no real waiting.

`page.clock` fakes only in-page timers; it does not move the fake server or the network. L8 (abort mid-stream) therefore uses the [fake-model-server](fake-model-server.md) delay/hold control to keep the SSE stream open until the test aborts, and waits in real time.

Y4 (websocket drop and reconnect) gets its drop from Playwright's `routeWebSocket`: the test interposes on the `/api/ws/{projectId}` connection, passes traffic through, then severs the server side — storage itself stays untouched — and observes the reconnect attempts arrive with backoff, the timers driven by `page.clock` since the backoff is an in-page timer (`nabu-frontend/app/lib/server/sync/websocket.ts:16,58-65`).

Claims about bytes on disk — Y8's plain-Markdown project directory and the companion files of E1/E3 — are asserted through the harness's volume-read promise ([stack-harness](stack-harness.md), "Volume read"), since storage exposes no file-read endpoint and its image has no shell.

### Coverage report

A reporter registered in the Playwright config prints a claim-coverage report at the end of every run, one row per claim of the tiers whose projects ran:

- `claim` — the label as it appears in the claims file, `D1` through `Y8`
- `tier` — the claim's tier marker, copied from the claims file
- `tests` — the titles of the tests tagged with the label
- `verdict` — `pass` when every tagged test passed, `fail` when any failed, `untested` when no test carries the tag

On an unfiltered run the reporter exits nonzero when any claim in the run's tiers is `untested`, so a claim cannot lose its coverage silently in CI. On a filtered run — `--grep` or named files — it reports only the claims the filter touched and never fails on the others' absence, or `--grep @E1` could never exit zero. The suite never edits `frontend-behavior-claims.md`; a human reads the report and updates the checkboxes.

One claim is knowingly partial: P1's "batched twenty files at a time" fragment (`DB_SYNC_BATCH_SIZE = 20`, `nabu-frontend/app/domain/db/database.ts:27`) has no observation channel among the components — the e2e tests cover delete-plus-reinsert and the debounce, the batch size stays with the frontend's unit suites, and P1's checkbox records a partial verdict.

### What the suite requires from its neighbors

- [fake-model-server](fake-model-server.md) — fixture answers for stubbed-tier model and embeddings calls, a request journal filtered by `X-Project-ID`, and the delay/hold control for stream-abort tests.
- [stack-harness](stack-harness.md) — a booted stack reachable at a base URL, teardown after the run, the recorded booted tier for the real-project guard, the volume-read channel for on-disk claims, and API key wiring for the `real` project.
- [frontend-test-hook](frontend-test-hook.md) — `window.__nabuTest` for DuckDB assertions, and the env override behind E5/E6.
- [seeder](seeder.md) — the boot-time base project loaded from `base-project/`.

## Prior art

nabu-frontend's own test idiom is colocated vitest suites — `*.test.ts` files beside their sources, such as `nabu-frontend/app/domain/db/projections.test.ts` — driven by JSON fixture files where behavior is scenario-shaped (`nabu-frontend/app/lib/agent/tools/shell/scenarios/`). The suite keeps that idiom's fixture-file spirit for the fake's canned responses and leaves the unit suites untouched, as [spec.md](spec.md#what-must-not-change) pins.

The claims file itself is the repo's precedent for a checklist as source of truth: labels plus checkboxes, updated by a human against evidence. The coverage report feeds that pattern instead of replacing it.

Playwright projects with grep tags are the standard mechanism for tiered, label-selected suites, per the two Playwright docs pages linked above. Cypress and other runners were considered and rejected in one line: Playwright dominates current practice and is already a devDependency of nabu-frontend (`playwright ^1.57.0`, `nabu-frontend/package.json:113`).

## Tests

### Skeleton

The first file written is the walking skeleton itself, `tests/walking-skeleton.spec.ts`, implementing steps 2–5 of [spec.md's walking skeleton](spec.md#walking-skeleton). It sits at the test root, untagged — it pins the wiring, not a claim, and the coverage report ignores untagged tests. Given the stubbed stack is booted and a fresh project is seeded, when the test opens the app, sends one chat message, queries the `files` table through `window.__nabuTest`, and reads the fake's journal, then the fixture's marker text renders, rows exist, and the boot-time embeddings request is recorded.

### Contract cases, riskiest first

Journal scoping is unforgeable. Given two tests running in parallel workers, each triggering model calls in its own project, when each asserts on the journal helper it was handed, then each sees only entries carrying its own project id — and the helper exposes no way to request another project's entries, so the cross-project assertion cannot be written by accident.

Tag-to-claim integrity. Given a test file loses its `@E1` tag, when the default unfiltered run completes, then the run exits nonzero with E1 reported `untested`; and given the same suite run with `--grep @D1`, then the run's exit reflects only the D1 tests, with no `untested` failure for the rest.

Seeding satisfies the boot gate. Given a project seeded through the worker fixture — a fresh UUID that received at least one `WriteFile` — when the app navigates to it, then the loading gate opens before its 30s timeout because storage seeded `settings.hidden.md` and `preferences.md` on connect. Given a project id that received no write, when the app navigates to it, then the gate times out — pinning that the fixture's write-before-navigate order is load-bearing.

Boot leaves a clean journal. Given the standing boot fixture set and a freshly seeded project, when the app finishes booting, then the journal for that project holds no entry with `fixture` null — pinning that the boot fixtures actually cover everything boot sends, so unmatched entries stay meaningful as test failures.

### Isolation

The suite reaches the stack only through the base URL the harness exports; running tests against an already-booted stack re-invokes nothing from [stack-harness](stack-harness.md), so the edit-run loop during development is Playwright alone. A single test runs headed for debugging:

```sh
npx playwright test tests/walking-skeleton.spec.ts --project stubbed --headed
```
