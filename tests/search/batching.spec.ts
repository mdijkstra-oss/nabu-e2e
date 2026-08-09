import { test, expect } from "../helpers/fixtures"
import {
  settingsWithSearches,
  waitForChunks,
  gotoSearch,
  hitLocator,
  entriesFor,
  stringifyBody,
  countOccurrences,
} from "../helpers/search"

// Fixed English clause keeping franc's per-chunk language detection on "eng"
// for every seeded doc — a stray detection drops the doc from the language's
// index and skews the batch split.
const anchor = "and the team wrote down what changed there and why it mattered for the following week"

const fillers = [
  "on schedule",
  "after a short delay",
  "with little fanfare",
  "during the quarterly review",
  "despite the weather",
  "to everyone's relief",
  "under budget",
  "with the whole team present",
  "after two postponements",
  "in record time",
  "with reservations noted",
  "following a long debate",
]

test(
  "verdict batches of ten are judged concurrently and surface per batch",
  { tag: ["@S5"] },
  async ({ page, project }) => {
    // BM25 length normalization ranks the ten short docs above the two long
    // ones, so the verdict batches split as batch1 = E2ES5BATCH1 docs and
    // batch2 = E2ES5BATCH2 docs — which is what the two filter fixtures key on.
    const longTail =
      " even though nobody at the time expected the record to matter much, it was copied out in full, " +
      "read aloud at the next meeting, and pinned to the corkboard beside the kitchen door for a season"
    const files: string[] = []
    for (let i = 0; i < 12; i++) {
      const name = `s5-note-${String(i + 1).padStart(2, "0")}.md`
      files.push(name)
      const batchTag = i < 10 ? "E2ES5BATCH1" : "E2ES5BATCH2"
      const tail = i < 10 ? "" : longTail
      await project.seed(
        name,
        `E2ESEARCHCORPUS E2ES5KW ${batchTag} Note number ${i + 1} records the milestone ${fillers[i]} ${anchor}${tail}.\n`
      )
    }
    await project.seed(
      "settings.hidden.md",
      settingsWithSearches([
        {
          id: "search-e2es5",
          title: "S5",
          description: "batching",
          highlight: "E2ES5HL milestone notes",
          sql: "SELECT file, text, SEMANTIC('E2ES5QUERY which notes record milestones') FROM files LIMIT 30",
        },
      ])
    )
    await project.open(page)
    await waitForChunks(page, files)
    await gotoSearch(page, project, "search-e2es5")

    // 12 hits chunk into batches of 10 and 2. One batch's reply is held for
    // 8s at the fake; the other answers at once. A pipeline that judged
    // batches sequentially, or surfaced only after the whole run, could not
    // show exactly one result here.
    await expect(hitLocator(page)).toHaveCount(1, { timeout: 30_000 })

    // While the slow batch is still in flight, both batch requests are
    // already journaled — the batches were dispatched concurrently.
    const journal = await project.journal()
    const filterBodies = entriesFor(journal, "/semantic-filter")
      .map((e) => stringifyBody(e.body))
      .filter((b) => b.includes("E2ES5HL"))
    expect(filterBodies).toHaveLength(2)
    const targetCounts = filterBodies
      .map((b) => countOccurrences(b, "<target prefix="))
      .sort((a, b) => a - b)
    expect(targetCounts).toEqual([2, 10])

    // The held batch lands later and its result joins the page.
    await expect(hitLocator(page)).toHaveCount(2, { timeout: 30_000 })
  }
)

test(
  "consecutive barren batches stop paging before the candidate pool is exhausted",
  { tag: ["@S6"] },
  async ({ page, project }) => {
    // 88 single-chunk docs -> 9 verdict batches. maxBarren = ceil(30/10) = 3
    // and concurrency is 5, so at most 5 + 2 batches can ever be judged.
    const files: string[] = []
    for (let i = 0; i < 88; i++) {
      const name = `s6-entry-${String(i + 1).padStart(2, "0")}.md`
      files.push(name)
      await project.seed(
        name,
        `E2ESEARCHCORPUS E2ES6KW Entry ${i + 1} sits in the archive ${fillers[i % fillers.length]} ${anchor}.\n`
      )
    }
    await project.seed(
      "settings.hidden.md",
      settingsWithSearches([
        {
          id: "search-e2es6",
          title: "S6",
          description: "barren exit",
          highlight: "E2ES6HL archive entries",
          sql: "SELECT file, text, SEMANTIC('E2ES6QUERY entries in the archive') FROM files LIMIT 30",
        },
      ])
    )
    await project.open(page)
    await waitForChunks(page, [files[0], files[87]])
    await gotoSearch(page, project, "search-e2es6")

    await expect(page.getByText("No results found")).toBeVisible({ timeout: 60_000 })

    const journal = await project.journal()
    const filterCalls = entriesFor(journal, "/semantic-filter").filter((e) =>
      stringifyBody(e.body).includes("E2ES6HL")
    )
    // The allowance (3 barren batches for a request of 30) was used up...
    expect(filterCalls.length).toBeGreaterThanOrEqual(3)
    // ...and paging stopped: of 9 available batches at most 7 were judged.
    expect(filterCalls.length).toBeLessThanOrEqual(7)
  }
)
