# Frontend test hook

The [claims e2e suite](spec.md) needs to see the frontend's in-browser DuckDB, and this component is the one change it makes to nabu-frontend: a `window.__nabuTest` hook, present only in builds made with the `VITE_E2E` flag, that the [test-suite](test-suite.md) calls to run read-only SQL.

## Contract

`window.__nabuTest` has one member:

- `query(sql)` — runs the SQL string against the app's own DuckDB singleton, routed through the existing `Database.query` (`nabu-frontend/app/lib/db/init.ts:65-68`) reached via `getDatabase()` (`nabu-frontend/app/domain/db/database.ts:127`). It resolves with the result rows. It rejects when the SQL fails — a missing table included — carrying the database's own error message, the `Query failed: <cause>` text `executeQuery` already produces (`nabu-frontend/app/lib/db/query.ts:61`), so tests can assert on absence as well as presence.

One member is enough: the claims that need SQL introspection — [P1–P3, E4, and D3](../../../../frontend-behavior-claims.md) — all reduce to reading projected rows. The mutation timeline (claim D8) needs no member of its own — it renders in the chat sidebar (`nabu-frontend/app/ui/components/nabu/NabuChatSidebar.tsx:63-64`), so tests assert it through the UI.

The hook offers no path to the file store: `query` reaches only the in-browser DuckDB, so a stray statement can at worst disturb projected rows the next projection rebuilds, never a document. A test that writes documents goes through the UI and hits the app's own validating write path — the very behavior claims D4–D7 are about.

One more channel, paid for by claims E5 and E6: in flag-on builds, `getEnv` consults a localStorage override — key `nabu-e2e-env`, a JSON object mapping env names to values — before `import.meta.env`. Those claims describe what happens when the embeddings width or model *changes*, and the real values are baked at build time, unreachable for a suite booting one image per run; the override lets a test reload the same build with a different `VITE_EMBEDDINGS_DIMENSIONS` or `VITE_EMBEDDINGS_MODEL` and observe the reaction ([test-suite](test-suite.md), "Determinism"). With the flag off the override code is absent from the bundle, the same elimination property as the hook itself. The override is read once per page load; unparseable JSON or a non-string value is ignored in full, the defensive read the debug options already model (`nabu-frontend/app/routes/project.tsx:110-118`).

Availability: `window.__nabuTest` is either absent or fully callable, never half-initialized. It appears only once the DuckDB singleton is ready, so a test polling for it cannot race the database; the mechanism is the builder's choice, and `waitForDatabase()` (`nabu-frontend/app/domain/db/database.ts:29`) is the existing readiness signal.

The flag is `VITE_E2E`, following the repo's env convention `getEnv(key, fallback)` (`nabu-frontend/app/lib/utils/env.ts:4-5`): unset and empty string both mean off. The Dockerfile's build-arg block (`nabu-frontend/Dockerfile:16-30`) gains a matching `ARG`/`ENV` pair for `VITE_E2E`, since only declared args reach `npm run build` inside docker.

The gate is build-time, not runtime: Vite bakes `VITE_*` values into the static bundle at build (`nabu-frontend/Dockerfile:16-30` states this), and with the flag off the hook code must be absent from the built output — eliminated, not merely inert. This is verifiable by grepping the built client bundle for `__nabuTest` and finding no match. Because `getEnv` reads `import.meta.env` by dynamic key, which Vite leaves as a runtime lookup, the builder must keep the inclusion decision statically visible to the bundler; the bundle grep in Tests is what enforces the property.

Side effects: none beyond reading the database.

## Prior art

- `getEnv(key, fallback)` (`nabu-frontend/app/lib/utils/env.ts`) is the repo's convention for `VITE_*` flags with fallbacks; the flag read follows it.
- `import.meta.env.DEV` at `nabu-frontend/app/root.tsx:50` is the existing build-time-flag branch — stack traces render only in dev builds.
- The debug toggles (`nabu-frontend/app/ui/components/editor/debug-config.tsx`, persisted in localStorage as `nabu-debug-options` at `nabu-frontend/app/routes/project.tsx:108-123`) are the existing runtime-toggle idiom. The hook is not one of these: a runtime toggle ships the code to every user, while the build-time gate keeps it out of the production bundle entirely.
- A window-exposed hook gated by a build flag is the common Playwright pattern for reaching app internals; nothing beyond that is borrowed from outside the repo.

## Tests

### Skeleton

The hook's slice of the [walking skeleton](spec.md#walking-skeleton) is step 4: given the booted stubbed stack with the e2e frontend build, when the test calls `window.__nabuTest.query()` against the `files` table, then rows exist.

### Contract cases

Riskiest first:

1. Production build contains no hook — the spec-level [must-not-change pin](spec.md#what-must-not-change). Given a frontend build without `VITE_E2E`, when the built client bundle is grepped for `__nabuTest` and `nabu-e2e-env`, then there is no match; and when the app loads in a browser, then `window.__nabuTest` is undefined and the localStorage key is ignored.
2. Flag-on build attaches without a race. Given a build with `VITE_E2E` set, when a test polls for `window.__nabuTest` from page load onward, then the hook never appears without a callable `query`, and a query issued the moment it appears succeeds.
3. Errors pass through. Given the flag-on build with the app booted, when `query` targets a table that does not exist, then the promise rejects and the message names the missing table — the assertion claim P1 relies on to see delete-before-reinsert.
4. Env override governs only flag-on. Given a flag-on build with `nabu-e2e-env` holding a `VITE_EMBEDDINGS_DIMENSIONS` value before load, when the app reads that variable, then the override value wins over the baked one; the flag-off half is contract case 1.
5. Unit suites unaffected — the spec's [other pin](spec.md#what-must-not-change). Given the nabu-frontend repo with the hook change applied, when `vitest run` executes with and without `VITE_E2E` stubbed, then the colocated `*.test.ts` suites pass unchanged.

### Isolation

A vitest unit test covers the attach decision with the env mocked both ways and the database module stubbed: flag set attaches the hook once readiness resolves; flag absent attaches nothing; a stubbed query error surfaces as a rejection with the message intact. The repo already mocks env this way — `vi.stubEnv` at `nabu-frontend/app/lib/embeddings/env.test.ts:38` and `nabu-frontend/app/lib/server/env.test.ts:81` — so the test follows that pattern. Bundle absence is not provable in vitest; only contract case 1, run against the built output, pins it.
