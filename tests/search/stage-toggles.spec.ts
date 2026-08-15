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

// Trim keeps ~30 words of context around a kept range, so the flanking sentences carry
// their markers at the far ends — outside any context the trim stage may keep. The whole
// document is one unit, which is what makes the first hit the one the filter judged: with
// two units nothing decides which ranks first, because the fake's vectors only agree when
// the text does.
const DOC =
  "E2ES9FIRST the survey took weeks to plan, with volunteers fetching maps, borrowing tools, reading through notes kept from earlier seasons, and arguing gently towards a rotation that covered every plot fairly. " +
  "Volunteers E2ES9SECOND catalogued the beds thoroughly. " +
  "Afterwards the records were copied into three ledgers, checked against photographs, argued over during two long meetings, annotated with weather remarks, and shelved in the cabinet by the greenhouse door E2ES9THIRD. " +
  "E2ESEARCHCORPUS E2ES9KW closing line."

const s9FilterCount = async (project: { journal: () => Promise<{ path: string; body: unknown; seq: number; fixture: string | null; projectId: string | null }[]> }) =>
  entriesFor(await project.journal(), "/semantic-filter").filter((e) =>
    stringifyBody(e.body).includes("E2ES9HL")
  ).length

test(
  "disabling the filter stage at runtime shows the raw fused candidates; stages toggle individually",
  { tag: ["@stubbed"] },
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
  "every stage after probe can be turned off individually, the per-file cap included",
  { tag: ["@stubbed"] },
  async ({ page, project }) => {
    const sentences: string[] = []
    for (let i = 1; i <= 240; i++) sentences.push(capSentence(i))
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
    // With every stage after probe off, the raw fused candidate set surfaces.
    await presetDebugOptions(page, {
      skipMerge: true,
      skipFilter: true,
      skipCap: true,
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
    await expect(hitLocator(page)).toHaveCount(totalChunks)
  }
)
