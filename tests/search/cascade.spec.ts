import { test, expect, nabuQuery } from "../helpers/fixtures"
import {
  settingsWithSearches,
  presetDebugOptions,
  waitForChunks,
  gotoSearch,
  hitLocator,
  entriesFor,
  stringifyBody,
  countOccurrences,
} from "../helpers/search"
import { sendChat } from "../helpers/chat"

const capSentence = (i: number): string =>
  `The E2ES4KW E2ES4CAPDOC record ${i} lists what the team changed about routine ${i} that week.`

test(
  "the per-file cap stops one document from crowding the judged results",
  { tag: ["@S4"] },
  async ({ page, project }) => {
    const sentences: string[] = []
    for (let i = 1; i <= 120; i++) sentences.push(capSentence(i))
    await project.seed("s4-cap.md", "E2ESEARCHCORPUS " + sentences.join(" ") + "\n")
    await project.seed(
      "settings.hidden.md",
      settingsWithSearches([
        {
          id: "search-e2es4cap",
          title: "S4 cap",
          description: "per-file cap",
          highlight: "E2ES4HL concrete adaptation tactics",
          sql: "SELECT file, text, SEMANTIC('E2ES4QUERY concrete adaptation tactics') FROM files LIMIT 200",
        },
      ])
    )
    // Merge off so the cap's effect stays visible as a count of judged chunks.
    await presetDebugOptions(page, { skipMerge: true })
    await project.open(page)
    await waitForChunks(page, ["s4-cap.md"])

    const rows = (await nabuQuery(
      page,
      "SELECT count(*)::int AS n FROM files WHERE file = 's4-cap.md'"
    )) as { n: number }[]
    const totalChunks = rows[0].n
    const cap = Math.max(10, Math.ceil(totalChunks / 2))
    expect(totalChunks).toBeGreaterThan(cap)

    await gotoSearch(page, project, "search-e2es4cap")
    await expect(hitLocator(page).first()).toBeVisible({ timeout: 30_000 })

    const filterBodies = entriesFor(await project.journal(), "/semantic-filter")
      .map((e) => stringifyBody(e.body))
      .filter((b) => b.includes("E2ES4CAPDOC"))
    const judged = filterBodies.reduce((n, b) => n + countOccurrences(b, "<target prefix="), 0)
    expect(judged).toBe(cap)
  }
)

const mergeSentence = (i: number, marker: string): string =>
  `The pilot E2ES4KW cohort logged step ${i} of the rollout in the shared E2ES4MERGEDOC diary ${marker}.`

test(
  "adjacent high-scoring chunks merge and re-slice so passages cross chunk boundaries whole",
  { tag: ["@S4"] },
  async ({ page, project }) => {
    // ~1700 chars -> two overlapping chunks; sentence 9 sits in the overlap
    // zone around byte 800-1000. Naive concatenation would repeat it; a
    // merged region re-sliced from the source carries it exactly once.
    const sentences: string[] = []
    for (let i = 1; i <= 16; i++) {
      const marker = i === 1 ? "E2ES4HEAD" : i === 9 ? "E2ES4MID" : i === 16 ? "E2ES4TAIL" : "today"
      sentences.push(mergeSentence(i, marker))
    }
    await project.seed("s4-merge.md", "E2ESEARCHCORPUS " + sentences.join(" ") + "\n")
    await project.seed(
      "settings.hidden.md",
      settingsWithSearches([
        {
          id: "search-e2es4merge",
          title: "S4 merge",
          description: "merge and re-slice",
          highlight: "E2ES4HL concrete adaptation tactics",
          sql: "SELECT file, text, SEMANTIC('E2ES4QUERY concrete adaptation tactics') FROM files LIMIT 200",
        },
      ])
    )
    await project.open(page)
    await waitForChunks(page, ["s4-merge.md"])

    const rows = (await nabuQuery(
      page,
      "SELECT count(*)::int AS n FROM files WHERE file = 's4-merge.md'"
    )) as { n: number }[]
    expect(rows[0].n).toBe(2)

    await gotoSearch(page, project, "search-e2es4merge")
    await expect(hitLocator(page).first()).toBeVisible({ timeout: 30_000 })

    const filterBodies = entriesFor(await project.journal(), "/semantic-filter")
      .map((e) => stringifyBody(e.body))
      .filter((b) => b.includes("E2ES4MERGEDOC"))
    expect(filterBodies).toHaveLength(1)
    const body = filterBodies[0]
    // One merged target spanning both chunks, with the boundary-straddling
    // sentence whole and unduplicated.
    expect(countOccurrences(body, "<target prefix=")).toBe(1)
    expect(body).toContain("E2ES4HEAD")
    expect(body).toContain("E2ES4TAIL")
    expect(countOccurrences(body, "E2ES4MID")).toBe(1)
  }
)

const KEEP_DOC =
  "E2ES4FIRST the onboarding history covered how the team had slowly settled into shared rituals over many months, revisiting old calendars, complaining fondly about the office kitchen, and comparing the long list of small workarounds everyone had invented before any formal guidance ever appeared in writing anywhere. " +
  "The team E2ES4KW adapted quickly to the new tools. " +
  "E2ESEARCHCORPUS E2ES4KEEPDOC closing note E2ES4TRIMOUT."

const DROP_DOC =
  "E2ESEARCHCORPUS E2ES4DROPDOC The office E2ES4KW cafeteria menu changed on Fridays."

test(
  "scout then semantic filter judge candidates; trim cuts hits to the returned sentence ranges",
  { tag: ["@S4"] },
  async ({ page, project }) => {
    await project.seed("s4-codebook.md", "E2ES4FRAME Codebook: include only passages describing concrete adaptation tactics.\n")
    await project.seed("s4-keep.md", KEEP_DOC + "\n")
    await project.seed("s4-drop.md", DROP_DOC + "\n")
    await project.open(page)
    await waitForChunks(page, ["s4-keep.md", "s4-drop.md"])

    await sendChat(page, "Please run the project search E2ES4RUN now.")
    await expect(page.getByText("E2ES4DONE")).toBeVisible({ timeout: 60_000 })

    const journal = await project.journal()

    // Scout saw both candidate files with the framework, and dropped one.
    const scoutBodies = entriesFor(journal, "/scout-filter").map((e) => stringifyBody(e.body))
    expect(scoutBodies).toHaveLength(2)
    for (const b of scoutBodies) expect(b).toContain("E2ES4FRAME")
    expect(scoutBodies.filter((b) => b.includes("E2ES4KEEPDOC"))).toHaveLength(1)
    expect(scoutBodies.filter((b) => b.includes("E2ES4DROPDOC"))).toHaveLength(1)

    // Only the survivor reached the semantic filter, as a numbered passage.
    const filterBodies = entriesFor(journal, "/semantic-filter")
      .map((e) => stringifyBody(e.body))
      .filter((b) => b.includes("E2ES4HL"))
    expect(filterBodies).toHaveLength(1)
    expect(filterBodies[0]).toContain("E2ES4KEEPDOC")
    expect(filterBodies[0]).not.toContain("E2ES4DROPDOC")
    expect(filterBodies[0]).toContain('prefix=\\"a\\"')
    expect(filterBodies[0]).toContain("a-2")

    // The tool result carries the trimmed sentence range only.
    const outputs = entriesFor(journal, "/qual-coder")
      .flatMap((e) => ((e.body as { input?: { type?: string; output?: string }[] }).input ?? []))
      .filter((item) => item.type === "function_call_output")
      .map((item) => item.output ?? "")
    const searchOutput = outputs.find((o) => o.includes("s4-keep.md"))
    expect(searchOutput).toBeDefined()
    expect(searchOutput).toContain("adapted quickly to the new tools")
    expect(searchOutput).not.toContain("E2ES4TRIMOUT")
    expect(searchOutput).not.toContain("E2ES4DROPDOC")
  }
)

const EXTEND_S3 =
  "Their notes described the new rituals in exhausting detail, listing wake times, walk routes, snack breaks, and the slow drift of attention across the afternoon, all of it recorded faithfully in the shared notebook that the archivist later labelled E2ES4ANNOTEND"

const EXTEND_DOC =
  "E2ES4EXTENDDOC the diary study began as an informal habit among a handful of colleagues who wanted to remember how the strange first months had actually felt, before hindsight smoothed the record into something tidier and less honest than the daily entries themselves. " +
  "The pilot E2ES4KW group kept detailed diaries. " +
  EXTEND_S3 +
  ". E2ESEARCHCORPUS end."

// Starts inside the kept sentence so it overlaps the trimmed range, and runs
// to the end of sentence 3 so the extension is observable.
const ANNOTATION_TEXT = "group kept detailed diaries. " + EXTEND_S3

const ANNOTATION_BLOCK =
  "\n\n```json-annotations\n" +
  JSON.stringify({
    annotations: [
      {
        id: "ann-e2es4",
        text: ANNOTATION_TEXT,
        reason: "tracks the diary ritual",
        color: "amber",
      },
    ],
  }) +
  "\n```\n"

test(
  "extend appends overlapping annotations to a hit and grows its range to cover them",
  { tag: ["@S4"] },
  async ({ page, project }) => {
    await project.seed("s4-extend.md", EXTEND_DOC + ANNOTATION_BLOCK)
    await project.seed(
      "settings.hidden.md",
      settingsWithSearches([
        {
          id: "search-e2es4ext",
          title: "S4 extend",
          description: "annotation extension",
          highlight: "E2ES4HL concrete adaptation tactics",
          sql: "SELECT file, text, SEMANTIC('E2ES4QUERY concrete adaptation tactics') FROM files LIMIT 10",
        },
      ])
    )
    // renderAsJson exposes each hit's raw text, where the appended
    // json-annotations block is visible verbatim.
    await presetDebugOptions(page, { renderAsJson: true })
    await project.open(page)
    await waitForChunks(page, ["s4-extend.md"])
    await gotoSearch(page, project, "search-e2es4ext")

    const hit = hitLocator(page).first()
    await expect(hit).toBeVisible({ timeout: 30_000 })
    // The kept range was sentence 2; the annotation overlapping its tail pulled
    // the range out to the annotation's end and appended the annotation itself.
    const raw = hit.locator('pre[class*="whitespace-pre-wrap"]')
    await expect(raw).toContainText("kept detailed diaries")
    await expect(raw).toContainText("E2ES4ANNOTEND")
    await expect(raw).toContainText("json-annotations")
    await expect(raw).toContainText("tracks the diary ritual")
    // The block also renders as an annotation on the hit.
    await expect(hit.locator('pre[data-language="json-annotations"]')).toBeAttached()
  }
)
