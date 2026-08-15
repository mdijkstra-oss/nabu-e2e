import { test, expect } from "../helpers/fixtures"
import {
  settingsWithSearches,
  presetDebugOptions,
  waitForChunks,
  gotoSearch,
  hitLocator,
  entriesFor,
  stringifyBody,
} from "../helpers/search"

// Chunk text of a short single-line doc is its trimmed content, and the fake's
// embeddings are deterministic per string — so a hyde angle carrying this
// exact text scores cosine 1.0 against this chunk and nothing else.
const S1_VECTOR_DOC =
  "E2ESEARCHCORPUS The board postponed the modernization initiative after a long deliberation."
const S1_KEYWORD_DOC =
  "E2ESEARCHCORPUS E2ES1KW Participants mentioned the modernization initiative only in passing."

const S1_EMBEDDABLE_FROM_GENERATOR = [
  S1_VECTOR_DOC,
  "The initiative was eventually postponed by the board.",
  "It could be argued that the initiative faced some delays.",
  "There may have been hesitation around the initiative.",
  "As a result, the rollout slipped to the following quarter.",
  "Budget lines for the initiative were quietly reduced.",
  "Phrases like postponed, deferred and shelved appear nearby.",
  "Meeting minutes mention deliberation and delay.",
]
const S1_GENERIC_EMBEDDABLE_SAMPLE = "Generic hedged passage about possible postponement."

test(
  "semantic search expands the intent into hyde passages across five angles, embedded and searched independently",
  { tag: ["@stubbed"] },
  async ({ page, project }) => {
    await project.seed("s1-vector.md", S1_VECTOR_DOC + "\n")
    await project.seed("s1-keyword.md", S1_KEYWORD_DOC + "\n")
    await project.seed(
      "settings.hidden.md",
      settingsWithSearches([
        {
          id: "search-e2es1",
          title: "S1",
          description: "hyde expansion",
          highlight: "E2ES1HL passages about the modernization initiative",
          sql: "SELECT file, text, SEMANTIC('E2ES1QUERY how was the modernization initiative received') FROM files LIMIT 10",
        },
      ])
    )
    await project.open(page)
    await waitForChunks(page, ["s1-vector.md", "s1-keyword.md"])
    await gotoSearch(page, project, "search-e2es1")

    // Both retrieval routes surface: the vector doc is reachable only through
    // an embedded angle (it lacks the keyword token), the keyword doc only
    // through the keywords angle (no hyde text matches it in vector space).
    await expect(page.locator('[data-file-path="s1-vector.md"]').first()).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.locator('[data-file-path="s1-keyword.md"]').first()).toBeVisible()

    const journal = await project.journal()

    const hydeCalls = entriesFor(journal, "/hyde-generator").filter((e) =>
      stringifyBody(e.body).includes("E2ES1QUERY")
    )
    expect(hydeCalls.length).toBeGreaterThan(0)
    const genericCalls = entriesFor(journal, "/generic-hyde").filter((e) =>
      stringifyBody(e.body).includes("E2ES1QUERY")
    )
    expect(genericCalls.length).toBeGreaterThan(0)

    // One embeddings batch carries every embeddable angle from both hyde
    // calls; the keywords angles are never embedded (they feed full-text).
    const embeddingBatches = entriesFor(journal, "/embeddings").map(
      (e) => (e.body as { input: string[] }).input
    )
    const hydeBatch = embeddingBatches.find((input) =>
      input.includes(S1_EMBEDDABLE_FROM_GENERATOR[2])
    )
    expect(hydeBatch, "an embeddings batch carrying the hyde angle texts").toBeDefined()
    for (const text of S1_EMBEDDABLE_FROM_GENERATOR) {
      expect(hydeBatch).toContain(text)
    }
    expect(hydeBatch).toContain(S1_GENERIC_EMBEDDABLE_SAMPLE)
    expect(hydeBatch).not.toContain("E2ES1KW")
    expect(hydeBatch).not.toContain("modernization initiative postponed")
  }
)

const S3_MANY_DOC =
  "E2ESEARCHCORPUS E2ES3BOTH E2ES3MANYKW The committee endorsed the proposal and the field teams adopted it within a month."
const S3_ONE_DOC = "E2ESEARCHCORPUS E2ES3BOTH A single reviewer strongly objected to the proposal."

test(
  "vector and full-text lists fuse by reciprocal rank; many-angle chunk outranks a strong single-angle chunk",
  { tag: ["@stubbed"] },
  async ({ page, project }) => {
    await project.seed("s3-many.md", S3_MANY_DOC + "\n")
    await project.seed("s3-one.md", S3_ONE_DOC + "\n")
    await project.seed(
      "settings.hidden.md",
      settingsWithSearches([
        {
          id: "search-e2es3",
          title: "S3",
          description: "rrf",
          highlight: "E2ES3HL reactions to the proposal",
          sql: "SELECT file, text, SEMANTIC('E2ES3QUERY how did people respond to the proposal') FROM files LIMIT 10",
        },
      ])
    )
    // Filter off: the page shows the raw fused candidates in fused order,
    // which is the claim's observable.
    await presetDebugOptions(page, { skipFilter: true })
    await project.open(page)
    await waitForChunks(page, ["s3-many.md", "s3-one.md"])
    await gotoSearch(page, project, "search-e2es3")

    await expect(hitLocator(page)).toHaveCount(2, { timeout: 30_000 })
    // s3-many matches four embedded angles plus full-text; s3-one matches one
    // embedded angle at cosine 1.0 plus full-text. RRF puts many-angles first.
    await expect(hitLocator(page).nth(0).locator("[data-file-path]")).toHaveAttribute(
      "data-file-path",
      "s3-many.md"
    )
    await expect(hitLocator(page).nth(1).locator("[data-file-path]")).toHaveAttribute(
      "data-file-path",
      "s3-one.md"
    )
  }
)
