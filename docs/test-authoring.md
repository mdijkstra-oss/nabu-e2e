# Writing tests

How to add tests to this suite. The spec behind it all is in
`docs/specs/2026-08-08-01-claims-e2e-suite/`.

Before adding one, check it belongs at this tier: it must cross a boundary that
cannot be faked without changing what is under test, be a journey someone
performs rather than a variation on one, and be able to fail for a reason no
in-process test could produce. `nabu-frontend/AGENTS.md` states the rule; a
behavior that fails any part of it belongs in a unit test or a story.

## Layout

- `tests/<section>/` — one folder per area (`documents/`, `projection/`,
  `embeddings/`, `search/`, `grounded/`, `consensus/`, `agent-loop/`, `tools/`, `sync/`).
- `fixtures/` — YAML replies for the fake model server. Read once at the fake's
  startup; run `scripts/reload-fixtures.sh` after changing them.
- `base-project/` — the corpus every project is seeded with.
- `tests/helpers/fixtures.ts` — the `test` extension and helpers below.

## Running against a booted stack

Boot once, keep it, then iterate:

```sh
NABU_E2E_KEEP=1 npx playwright test tests/walking-skeleton.spec.ts --project stubbed  # boots, keeps
NABU_E2E_REUSE=1 npx playwright test tests/search/ --project stubbed                  # reuses, no teardown
```

`scripts/compose.sh <args>` wraps `docker compose` with the right files, project
name, and variables (`scripts/compose.sh logs embeddings`, `... ps`).

## Tests

Tag every test with its tier — `@stack`, `@stubbed` or `@real` — which is what
selects it into a Playwright project:

```ts
import { test, expect, nabuQuery } from "../helpers/fixtures"

test("chart blocks store the query, not the numbers", { tag: ["@stack"] }, async ({ page, project }) => {
  await project.seed("marker-doc.md", "# Chart\n\n...")
  await project.open(page)
  ...
})
```

The `project` fixture gives every test a fresh project seeded with
`base-project/`:

- `project.id` — its UUID.
- `project.seed(path, content)` — write one more file through the storage API.
  Seed *before* `project.open`; the app's boot gate needs at least one file to
  exist and reads the file list once at connect.
- `project.open(page)` — navigate and wait for the loading gate (chat textarea
  visible). Sets `skipCache: true` in the app's debug options first; pass
  `{ skipCache: false }` only for the response-cache test.
- `project.journal()` — the fake's journal entries for this project only:
  `{seq, path, projectId, body, fixture}`. Assert only on your own project's
  entries; parallel workers share the fake.
- `nabuQuery(page, sql)` — read-only SQL against the in-browser DuckDB
  (`window.__nabuTest`). Rejects with the database's own message on bad SQL.
- `readVolumeFile(relPath)` / `listVolumeDir(relPath)` from `harness/volume` —
  bytes on disk inside the storage volume (`<projectId>/<file>`), for tests
  about files on disk.

UI entry points: chat is `textarea[name="chat-message"]`, Enter sends. The app
lands on `/project/<id>`; a document opens at `/project/<id>/file/<fileId>`.

## Fixtures for the fake

One YAML file per scripted reply, in `fixtures/`:

```yaml
endpoint: /qual-coder          # path after the proxy strips /llm — never /llm/...
contains: MY-UNIQUE-MARKER     # string or list; all must appear in the request text
reply:                         # or `replies:` for an ordered list (last repeats)
  text: "prose streamed as deltas"
  # json: {…}                  # for endpoints called with a response format
  # toolCalls: [{name: query, args: {sql: "select 1"}}]
  # error: {message: "…", type: "…", status: 500}   # without status: stream ends in response.failed
  # events: [{event: "...", data: {...}}]           # raw escape hatch
  # delayMs / interEventMs / hold                    # timing and abort control
```

Rules that keep parallel runs sane:

- Match on a **unique marker string** you plant in the seeded document or chat
  message, prefixed with the test's own name (`E2E-CHART-QUERY-…`). Matching is stateless;
  markers are what separate tests and turns.
- More `contains` strings win over fewer on the same endpoint; an exact tie
  fails loud. Never rely on fixture file order.
- **The transcript accumulates.** Opening a project fires a greeting turn whose
  "GREETING MODE" system message is echoed into every later `/qual-coder`
  request, so a chat-turn fixture must carry `["GREETING MODE", "YOUR-MARKER"]`
  to out-specify `boot-greeting.yaml`; a second turn in the same conversation
  carries the first turn's marker too, and so on — each turn's fixture lists
  everything already in the transcript plus its own marker.
- An unmatched request is a 501 that shows up in the UI and journals as
  `fixture: null` — that is a test failure signal, not background noise. The
  standing `boot-topic-assigner.yaml` covers boot traffic; embeddings need no
  fixtures.
- After adding or editing fixtures: `scripts/reload-fixtures.sh` (the running
  fake never re-reads the directory). An invalid fixture kills the fake at
  start — the script prints its logs when that happens.

## Timing

- In-page timers (the 500ms write debounce, the 5s embeddings debounce, the
  websocket backoff) are driven with `page.clock` — install before the timer
  starts, advance, assert. No real waiting.
- The fake's `interEventMs`/`hold` control the stream side (L8 abort); that
  waits in real time, `page.clock` cannot move the network.
- Websocket drops: `page.routeWebSocket` on `/api/ws/<projectId>`, pass
  traffic through, sever server-side; storage stays untouched.

## What this tier cannot see

Sync batching — "twenty files at a time" — has no observation channel here. It
stays with the frontend unit suites; the projection test covers the
delete-plus-reinsert and the debounce only.
