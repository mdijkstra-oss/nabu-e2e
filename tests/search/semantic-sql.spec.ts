import { test, expect, nabuQuery, type JournalEntry } from "../helpers/fixtures"
import { waitForChunks, entriesFor, stringifyBody } from "../helpers/search"
import { sendChat } from "../helpers/chat"

// SEMANTIC()/EMBEDDINGS_FROM_FILE() are resolved by the app's SQL layer, which
// the model's `query` tool fronts; the tool's function_call_output in the next
// /qual-coder request carries the resolved rows.

interface Row {
  file: string
  text?: string
  score?: number
}

interface ToolResult {
  status: string
  output: string
}

// function_call_output.output is a JSON-encoded {status, output} envelope.
const toolOutputs = (journal: JournalEntry[]): ToolResult[] =>
  entriesFor(journal, "/qual-coder")
    .flatMap((e) => ((e.body as { input?: { type?: string; output?: string }[] }).input ?? []))
    .filter((item) => item.type === "function_call_output")
    .map((item) => JSON.parse(item.output ?? "{}") as ToolResult)

const parseRows = (output: string): Row[] => {
  const end = output.lastIndexOf("]")
  expect(end, `tool output should carry a JSON row array: ${output.slice(0, 200)}`).toBeGreaterThan(
    -1
  )
  return JSON.parse(output.slice(0, end + 1)) as Row[]
}

const S10_TARGET =
  "E2ESEARCHCORPUS The quarterly report praised the outreach clinic for its steady growth."

test(
  "SEMANTIC() in SQL over files resolves to the matching chunk set, ordered by _semantic_score",
  { tag: ["@stubbed"] },
  async ({ page, project }) => {
    await project.seed("s10-target.md", S10_TARGET + "\n")
    await project.seed(
      "s10-memo.md",
      "E2ESEARCHCORPUS E2ES10KW A brief memo mentions the outreach clinic.\n"
    )
    await project.seed(
      "s10-note.md",
      "E2ESEARCHCORPUS E2ES10KW Another note mentions the clinic staffing twice.\n"
    )
    await project.open(page)
    await waitForChunks(page, ["s10-target.md", "s10-memo.md", "s10-note.md"])

    await sendChat(page, "Please run the query E2ES10RUN.")
    await expect(page.getByText("E2ES10DONE")).toBeVisible({ timeout: 60_000 })

    const result = toolOutputs(await project.journal()).find((o) =>
      o.output.includes("s10-target.md")
    )
    expect(result, "query tool output with the resolved chunk set").toBeDefined()
    expect(result!.status).toBe("ok")
    const rows = parseRows(result!.output)

    // The chunk set: all three matching docs, each row a chunk with its file
    // and text.
    const files = rows.map((r) => r.file)
    expect(files).toContain("s10-target.md")
    expect(files).toContain("s10-memo.md")
    expect(files).toContain("s10-note.md")
    for (const row of rows) expect(typeof row.text).toBe("string")

    // ORDER BY _semantic_score DESC executed: scores are present and
    // descending, and the vector-matched doc outscores the weaker
    // keyword-only doc.
    const scores = rows.map((r) => r.score ?? 0)
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThanOrEqual(scores[i - 1])
    const scoreOf = (file: string) => rows.find((r) => r.file === file)?.score ?? 0
    expect(scoreOf("s10-target.md")).toBeGreaterThan(scoreOf("s10-note.md"))
  }
)

const S11_NOTE = "E2ESEARCHCORPUS E2ES11NOTE Codebook entry: moments where routine replaced spontaneity."
const S11_ECHO = "E2ESEARCHCORPUS E2ES11KW Her fixed walk and email curfew replaced the old spontaneity."

test(
  "EMBEDDINGS_FROM_FILE() makes the named file the query and finds what echoes it",
  { tag: ["@stubbed"] },
  async ({ page, project }) => {
    await project.seed("s11-note.md", S11_NOTE + "\n")
    await project.seed("s11-echo.md", S11_ECHO + "\n")
    await project.seed(
      "s11-unrelated.md",
      "E2ESEARCHCORPUS The cafeteria reopened after renovations.\n"
    )
    await project.open(page)
    await waitForChunks(page, ["s11-note.md", "s11-echo.md", "s11-unrelated.md"])

    await sendChat(page, "Please run the query E2ES11RUN.")
    await expect(page.getByText("E2ES11DONE")).toBeVisible({ timeout: 60_000 })

    const journal = await project.journal()

    // The named file itself became the query: its content went to /file-hyde.
    const fileHydeCalls = entriesFor(journal, "/file-hyde").filter((e) =>
      stringifyBody(e.body).includes("E2ES11NOTE")
    )
    expect(fileHydeCalls.length).toBeGreaterThan(0)
    expect(stringifyBody(fileHydeCalls[0].body)).toContain('name=\\"s11-note.md\\"')

    // The corpus was searched for what echoes the note.
    const result = toolOutputs(journal).find((o) => o.output.includes("s11-echo.md"))
    expect(result, "query tool output with the echoing chunk").toBeDefined()
    expect(result!.status).toBe("ok")
    const rows = parseRows(result!.output)
    expect(rows.map((r) => r.file)).toContain("s11-echo.md")
    expect(rows.map((r) => r.file)).not.toContain("s11-unrelated.md")
  }
)

test(
  "semantic matching and structural filters on projected tables execute as one SQL statement",
  { tag: ["@stubbed"] },
  async ({ page, project }) => {
    await project.seed(
      "s12-policy.md",
      "E2ESEARCHCORPUS E2ES12POLICYDOC E2ES12KW The council policy mandates hybrid attendance twice weekly.\n"
    )
    await project.seed(
      "s12-interview.md",
      "E2ESEARCHCORPUS E2ES12INTERVIEWDOC E2ES12KW The interviewee shrugged at the attendance mandate.\n"
    )
    await project.open(page)
    await waitForChunks(page, ["s12-policy.md", "s12-interview.md"])

    // The structural side: classification must have landed in the projected
    // attributes table before the query runs.
    await expect
      .poll(
        async () => {
          const rows = (await nabuQuery(
            page,
            "SELECT count(*)::int AS n FROM attributes WHERE file = 's12-policy.md' AND type = 'policy'"
          )) as { n: number }[]
          return rows[0]?.n ?? 0
        },
        { timeout: 60_000, message: "policy classification in the attributes table" }
      )
      .toBeGreaterThan(0)

    await sendChat(page, "Please run the query E2ES12RUN.")
    await expect(page.getByText("E2ES12DONE")).toBeVisible({ timeout: 60_000 })

    // Both docs match the semantic side (same keyword); the attributes
    // subquery keeps only the policy doc — meaning and structure in one
    // statement.
    const result = toolOutputs(await project.journal()).find((o) =>
      o.output.includes("s12-policy.md")
    )
    expect(result, "query tool output filtered by the attributes table").toBeDefined()
    expect(result!.status).toBe("ok")
    const rows = parseRows(result!.output)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.map((r) => r.file)).toContain("s12-policy.md")
    expect(rows.map((r) => r.file)).not.toContain("s12-interview.md")
  }
)
