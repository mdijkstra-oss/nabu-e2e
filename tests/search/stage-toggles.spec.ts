import { test, expect, nabuQuery } from "../helpers/fixtures"
import {
  settingsWithSearches,
  presetDebugOptions,
  waitForChunks,
  gotoSearch,
  hitLocator,
  entriesFor,
  stringifyBody,
} from "../helpers/search"

// Trim keeps ~30 words of context around a kept range, so the flanking
// sentences are long and carry their markers at the far ends — outside any
// context the trim stage may keep.
const DOC =
  "E2ES9FIRST the survey planning stretched across several weeks while volunteers gathered maps, borrowed tools, compared notes from earlier seasons, and slowly agreed on a fair rotation that would keep every plot covered without exhausting anyone during the long opening stretch of the growing season this year. " +
  "Volunteers E2ES9SECOND catalogued the beds thoroughly. " +
  "Afterwards the records were copied into three ledgers, checked against photographs, argued over during two long meetings, annotated with weather remarks, and finally shelved in the little cabinet beside the greenhouse door where nobody would look at them again until the next spring E2ES9THIRD. " +
  "E2ESEARCHCORPUS E2ES9KW closing line."

const s9FilterCount = async (project: { journal: () => Promise<{ path: string; body: unknown; seq: number; fixture: string | null; projectId: string | null }[]> }) =>
  entriesFor(await project.journal(), "/semantic-filter").filter((e) =>
    stringifyBody(e.body).includes("E2ES9HL")
  ).length

test(
  "disabling the filter stage at runtime shows the raw fused candidates; stages toggle individually",
  { tag: ["@S9"] },
  async ({ page, project }) => {
    await project.seed("s9-doc.md", DOC + "\n")
    await project.seed(
      "settings.hidden.md",
      settingsWithSearches([
        {
          id: "search-e2es9",
          title: "S9",
          description: "stage toggles",
          highlight: "E2ES9HL the cataloguing work",
          sql: "SELECT file, text, SEMANTIC('E2ES9QUERY how thorough was the garden survey') FROM files LIMIT 10",
        },
      ])
    )
    await project.open(page)
    await waitForChunks(page, ["s9-doc.md"])

    // Stages on: the model judgement trims the hit to the kept sentence.
    await gotoSearch(page, project, "search-e2es9")
    const hit = hitLocator(page).first()
    await expect(hit).toBeVisible({ timeout: 30_000 })
    await expect(hit).toContainText("E2ES9SECOND")
    await expect(hit).not.toContainText("E2ES9FIRST")
    await expect(hit).not.toContainText("E2ES9THIRD")
    const callsWithFilterOn = await s9FilterCount(project)
    expect(callsWithFilterOn).toBeGreaterThanOrEqual(1)

    // The debug menu offers each post-probe stage as its own toggle.
    await page.locator("button:has(svg.lucide-bug)").click()
    await expect(page.getByText("Step 3 — Skip merge (capped chunks, no fuse)")).toBeVisible()
    await expect(page.getByText("Step 4 — Skip scout pre-filter (framework)")).toBeVisible()
    await expect(page.getByText("Step 4 — Skip barren cutoff (keep filtering)")).toBeVisible()
    await expect(page.getByText("Step 6 — Skip annotation extension")).toBeVisible()

    // Turn the filter stage off at runtime and re-run the same search.
    await page.getByText("Step 4 — Skip filter (raw embeddings)").click()
    await gotoSearch(page, project, "search-e2es9")

    // Raw fused candidate: the whole chunk, no model call added.
    const rawHit = hitLocator(page).first()
    await expect(rawHit).toBeVisible({ timeout: 30_000 })
    await expect(rawHit).toContainText("E2ES9FIRST")
    await expect(rawHit).toContainText("E2ES9SECOND")
    await expect(rawHit).toContainText("E2ES9THIRD")
    expect(await s9FilterCount(project)).toBe(callsWithFilterOn)
  }
)

const capSentence = (i: number): string =>
  `The E2ES9KW capdoc sentence ${i} notes the survey of the garden beds in row ${i} without incident today.`

test(
  "every stage after probe can be turned off individually — the per-file cap has no runtime toggle",
  { tag: ["@S9"] },
  async ({ page, project }) => {
    const sentences: string[] = []
    for (let i = 1; i <= 108; i++) sentences.push(capSentence(i))
    await project.seed("s9-cap.md", "E2ESEARCHCORPUS " + sentences.join(" ") + "\n")
    await project.seed(
      "settings.hidden.md",
      settingsWithSearches([
        {
          id: "search-e2es9cap",
          title: "S9 cap",
          description: "cap toggle",
          highlight: "E2ES9HL the cataloguing work",
          sql: "SELECT file, text, SEMANTIC('E2ES9QUERY how thorough was the garden survey') FROM files LIMIT 200",
        },
      ])
    )
    // Every stage that offers a runtime switch is off. If each stage after
    // probe were individually disableable, some configuration would show the
    // full fused candidate set; the per-file cap has no switch, so it cannot.
    await presetDebugOptions(page, {
      skipMerge: true,
      skipFilter: true,
      skipTrim: true,
      skipAnnotationExtend: true,
      skipBarrenCheck: true,
    })
    await project.open(page)
    await waitForChunks(page, ["s9-cap.md"])

    const rows = (await nabuQuery(
      page,
      "SELECT count(*)::int AS n FROM files WHERE file = 's9-cap.md'"
    )) as { n: number }[]
    const totalChunks = rows[0].n
    expect(totalChunks).toBeGreaterThan(10)

    await gotoSearch(page, project, "search-e2es9cap")
    await expect(hitLocator(page).first()).toBeVisible({ timeout: 30_000 })
    // Claimed: raw fused candidates — all chunks of the file. The cap stage
    // still runs (max(10, half the file's chunks)) and cannot be turned off.
    await expect(hitLocator(page)).toHaveCount(totalChunks)
  }
)
