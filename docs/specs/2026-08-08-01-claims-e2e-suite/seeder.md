# Seeder

The seeder is the change this feature makes to `nabu-self-hosted`: the existing seed program ([nabu-self-hosted/seed/main.go](../../../../nabu-self-hosted/seed/main.go)) generalized to seed a first project from a directory of files, with its current welcome content as the default. It is the seeder component of the [claims e2e suite](spec.md); the [stack-harness](stack-harness.md) points it at the e2e base corpus, and outside e2e nothing about it changes.

## Contract

The program runs once at stack start, in the `welcome-seed` service slot (compose.yaml:182-191), and exits.

Environment in:

- **STORAGE_URL** — the storage API base, as today (main.go:41-44).
- **SEED_DIR** — optional. Unset: the program seeds its embedded welcome document, exactly the current behavior (main.go:15-27, 92). Set: the program seeds every regular file in the directory instead, each filename becoming the document path, in sorted order so runs are deterministic. The corpus must be flat and within storage's filename grammar: storage rejects nested paths and unusual characters (`nabu-storage/internal/lib/utils/id.go:17-50`, pinned by the `"nested directory"` case at `internal/domain/actions_test.go:182`), and its file listing is a flat directory read (`internal/domain/files/files.go:58-72`), so a subdirectory or out-of-grammar filename under `SEED_DIR` is a startup failure naming the offender, never a write attempt.

Behavior at the storage boundary, unchanged from today except for what is written:

- The empty signal stays the project list: the program seeds only when `GET /queries/projects` lists zero projects (main.go:13-14, 64-84), so it can never re-seed a store in use.
- It creates one project under a fresh UUIDv4 and lands one `WriteFile` command per file via `POST /commands/{projectId}` (main.go:86-111) — through storage's own write path, which is what creates the project directory and later lets storage seed the app's required `settings.hidden.md` and `preferences.md` on first websocket connect (see [test-suite](test-suite.md), "Per-test isolation").
- Any failure — unreadable `SEED_DIR`, `SEED_DIR` set but containing no regular files, a subdirectory or out-of-grammar filename, or any storage error — exits nonzero with the cause on stderr (main.go:48-62); a misconfigured mount must fail the boot loudly, not seed an empty project.

The directory's *content* is not the seeder's concern: the e2e base corpus lives in `nabu-e2e/base-project/` and is owned by the [test-suite](test-suite.md), which also reads the same directory when seeding per-test projects — one corpus source, two consumers, no drift.

## Prior art

The change extends the program in place: `run`, the empty check, and the command POST all stay (main.go:48-111); seeding N files is the existing single-file seed in a loop. Its test suite already fakes storage with `httptest` and asserts on recorded commands ([main_test.go](../../../../nabu-self-hosted/seed/main_test.go)) — the pattern the new cases follow.

Copying files straight into the storage volume was rejected: it would bypass storage's write path, so the project directory conventions and storage's required-files seeding would not apply, and the corpus would land without validation.

## Tests

### Skeleton

The seeder carries step 1's corpus in the [walking skeleton](spec.md#walking-skeleton): given the override stack boots with `SEED_DIR` mounted to `nabu-e2e/base-project/`, when readiness resolves, then the one listed project holds the base corpus files.

### Contract cases

Riskiest first:

1. **Default unchanged.** Given `SEED_DIR` unset, when the program runs against an empty store, then storage receives exactly one `WriteFile` of `welcome.md` with the welcome content — the existing cases `TestSeedsWhenStorageHoldsZeroProjects`, `TestDoesNothingWhenAnyProjectExists`, and `TestNeverRecreatesAfterWelcomeFileDeleted` (main_test.go:63-122) keep passing untouched.
2. **Directory seeding.** Given `SEED_DIR` holding several files, when the program runs against an empty store, then storage receives one `WriteFile` per file, filename as document path, all to the same project id, in sorted order.
3. **Empty signal still governs.** Given `SEED_DIR` set and a store already listing a project, when the program runs, then storage receives no writes.
4. **Loud misconfiguration.** Given `SEED_DIR` pointing at a missing or empty directory, or containing a subdirectory or a filename outside storage's grammar, when the program runs, then it exits nonzero naming the offender on stderr and storage receives no writes.
5. **Mid-seed failure.** Given storage rejecting the second of three writes, when the program runs, then it exits nonzero with storage's response on stderr — partial seeds are visible, never silent.

### Isolation

The program runs alone against an `httptest` fake storage and a temp directory, exactly as the existing suite does (main_test.go:24-61); no docker, no real storage.
