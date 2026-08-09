import { test, expect, nabuQuery, waitForBoot } from "../helpers/fixtures"
import {
  settingsWithSearches,
  waitForChunks,
  gotoSearch,
  hitLocator,
  entriesFor,
  stringifyBody,
} from "../helpers/search"

const ALPHA = "E2ESEARCHCORPUS E2ES7KW E2ES7ALPHA The mentoring program expanded steadily last year."
const BETA = "E2ESEARCHCORPUS E2ES7KW E2ES7BETA The mentoring program stalled in the spring."
const BETA_CHANGED =
  "E2ESEARCHCORPUS E2ES7KW E2ES7BETA E2ES7CHANGED The mentoring program stalled badly and was rebooted."

const s7FilterCalls = (journal: { path: string; body: unknown }[]) =>
  entriesFor(journal as never, "/semantic-filter").filter((e) =>
    stringifyBody(e.body).includes("E2ES7HL")
  )

test(
  "repeated search reuses cached verdicts; only changed content is re-judged",
  { tag: ["@S7"] },
  async ({ page, project }) => {
    await project.seed("s7-alpha.md", ALPHA + "\n")
    await project.seed("s7-beta.md", BETA + "\n")
    await project.seed(
      "settings.hidden.md",
      settingsWithSearches([
        {
          id: "search-e2es7",
          title: "S7",
          description: "verdict cache",
          highlight: "E2ES7HL mentoring program status",
          sql: "SELECT file, text, SEMANTIC('E2ES7QUERY mentoring program status') FROM files LIMIT 10",
        },
      ])
    )
    // The one claim that must run with the response cache ON.
    await project.open(page, { skipCache: false })
    await waitForChunks(page, ["s7-alpha.md", "s7-beta.md"])

    // First run judges both hits in one batch.
    await gotoSearch(page, project, "search-e2es7")
    await expect(hitLocator(page)).toHaveCount(2, { timeout: 30_000 })
    const afterFirst = s7FilterCalls(await project.journal())
    expect(afterFirst).toHaveLength(1)

    // Second run of the same search: verdicts come from the cache, the fake
    // never sees another filter call.
    await gotoSearch(page, project, "search-e2es7")
    await expect(hitLocator(page)).toHaveCount(2, { timeout: 30_000 })
    await page.waitForTimeout(2000)
    expect(s7FilterCalls(await project.journal())).toHaveLength(1)

    // Change one document; its chunk hash changes, the other's does not.
    // Reload the project so the boot sync re-embeds the edited file before
    // the search runs again.
    await project.seed("s7-beta.md", BETA_CHANGED + "\n")
    await page.goto(`/project/${project.id}`)
    await waitForBoot(page)
    await expect
      .poll(
        async () => {
          const rows = (await nabuQuery(
            page,
            "SELECT count(*)::int AS n FROM files WHERE text LIKE '%E2ES7CHANGED%'"
          )) as { n: number }[]
          return rows[0]?.n ?? 0
        },
        { timeout: 45_000, message: "edited chunk to reach the files table" }
      )
      .toBeGreaterThan(0)

    // Third run re-judges exactly the changed hit.
    await gotoSearch(page, project, "search-e2es7")
    await expect(hitLocator(page)).toHaveCount(2, { timeout: 30_000 })
    await expect
      .poll(async () => s7FilterCalls(await project.journal()).length, { timeout: 15_000 })
      .toBe(2)
    const rejudge = stringifyBody(s7FilterCalls(await project.journal())[1].body)
    expect(rejudge).toContain("E2ES7CHANGED")
    expect(rejudge).not.toContain("E2ES7ALPHA")
  }
)
