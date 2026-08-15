import { test, expect } from "../helpers/fixtures"
import {
  settingsWithSearches,
  waitForChunks,
  gotoSearch,
  hitLocator,
} from "../helpers/search"

const DOC =
  "E2ESEARCHCORPUS E2ES8KW The workshop opened with introductions. The facilitator E2ES8TARGET distributed the agenda midway. Attendance dwindled by evening."

test(
  "a result carries its file and can be followed back to the passage",
  { tag: ["@stubbed"] },
  async ({ page, project }) => {
    await project.seed("s8-doc.md", DOC + "\n")
    await project.seed(
      "settings.hidden.md",
      settingsWithSearches([
        {
          id: "search-e2es8",
          title: "S8",
          description: "follow back",
          highlight: "E2ES8HL the agenda hand-out",
          sql: "SELECT file, text, SEMANTIC('E2ES8QUERY when was the agenda handed out') FROM files LIMIT 10",
        },
      ])
    )
    await project.open(page)
    await waitForChunks(page, ["s8-doc.md"])
    await gotoSearch(page, project, "search-e2es8")

    const hit = hitLocator(page).first()
    await expect(hit).toBeVisible({ timeout: 30_000 })
    // The result names its file and shows the kept sentence.
    await expect(hit.locator("[data-file-path]")).toHaveAttribute("data-file-path", "s8-doc.md")
    await expect(hit).toContainText("E2ES8TARGET")

    // Follow the hit back: the reveal button navigates into the file at the
    // matched passage.
    await hit.hover()
    await hit.locator("button").click()

    await expect(page).toHaveURL(/\/file\/s8-doc\.md\?spotlight=/)
    const spotlight = page.locator('[data-spotlight="true"]')
    await expect(spotlight.first()).toBeVisible({ timeout: 30_000 })
    await expect(spotlight.first()).toContainText("E2ES8TARGET")
  }
)
