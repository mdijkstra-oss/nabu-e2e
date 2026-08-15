import { expect, nabuQuery, test } from "../helpers/fixtures"
import { openDocument, sendChat, seedAnnotationsDoc } from "../helpers/documents"

const P1_PROSE =
  "# P1 doc\n\nThe first sentence mentions autonomy at work. The second mentions isolation at home."

const p1Annotations = [
  { text: "autonomy at work", reason: "E2E-P1-R1", color: "blue", id: "annotation-1p1aaaaa" },
  { text: "isolation at home", reason: "E2E-P1-R2", color: "green", id: "annotation-1p1bbbbb" },
]

const reasonsFor = async (page: import("@playwright/test").Page, file: string): Promise<string[]> =>
  (
    (await nabuQuery(
      page,
      `select reason from annotations where file = '${file}' order by reason`
    )) as { reason: string }[]
  ).map((r) => r.reason)

test(
  "a block change replaces the file's rows (delete + reinsert), after a debounce",
  { tag: ["@stack"] },
  async ({ page, project }) => {
    await project.seed("p1-doc.md", seedAnnotationsDoc(P1_PROSE, p1Annotations))
    await openDocument(page, project, "p1-doc.md")

    await expect
      .poll(() => reasonsFor(page, "p1-doc.md"), { timeout: 30_000 })
      .toEqual(["E2E-P1-R1", "E2E-P1-R2"])

    // Freeze in-page timers so the projection debounce cannot fire on its own.
    // install() alone keeps the fake clock auto-ticking; pausing is what pins it.
    await page.clock.install()
    await page.clock.pauseAt(new Date(Date.now() + 1_000))

    await sendChat(page, "Please replace the first annotation. E2E-P1-REPLACE")

    // The second journaled request proves the tool ran and its write landed in
    // the in-memory store; the journal lives on the server, clock-independent.
    await expect
      .poll(
        async () =>
          (await project.journal()).filter((e) => e.fixture === "p-p1-replace-done.yaml").length,
        { timeout: 45_000 }
      )
      .toBeGreaterThanOrEqual(1)

    // Debounced: with timers frozen the rows are still the old ones.
    expect(await reasonsFor(page, "p1-doc.md")).toEqual(["E2E-P1-R1", "E2E-P1-R2"])

    // Release the debounce: the file's rows are replaced wholesale — the removed
    // annotation's row is gone, the new one is in, nothing duplicated.
    await page.clock.runFor(5_000)
    await expect
      .poll(
        async () => {
          await page.clock.runFor(1_000)
          return reasonsFor(page, "p1-doc.md")
        },
        { timeout: 30_000 }
      )
      .toEqual(["E2E-P1-R2", "E2E-P1-R3"])
  }
)

const P3_ATTRIBUTES = `\`\`\`json-attributes
{
	"tags": ["e2e-p3", "second-tag"],
	"date": "2024-03-05"
}
\`\`\``

const p3Annotations = [
  {
    text: "autonomy at work",
    reason: "E2E-P3-R1",
    color: "purple",
    id: "annotation-1p3aaaaa",
    locked: true,
    vote: { find: { found: 2, missed: 1 }, review: "E2E-P3-REVIEW" },
  },
]

test(
  "projected tables are named after the block language, with tableName and rowPath honored",
  { tag: ["@stack"] },
  async ({ page, project }) => {
    await project.seed(
      "p2-doc.md",
      seedAnnotationsDoc("# P2 doc\n\nAutonomy at work and isolation at home.", [
        { text: "Autonomy at work", reason: "E2E-P2-R1", color: "blue", id: "annotation-1p2aaaaa" },
        { text: "isolation at home", reason: "E2E-P2-R2", color: "green", id: "annotation-1p2bbbbb" },
      ])
    )
    await openDocument(page, project, "p2-doc.md")

    const tables = async (): Promise<string[]> =>
      (
        (await nabuQuery(
          page,
          "select table_name from information_schema.tables where table_schema = 'main'"
        )) as { table_name: string }[]
      ).map((t) => t.table_name)

    await expect.poll(tables, { timeout: 30_000 }).toContain("annotations")
    const names = await tables()
    // Language minus the json- prefix.
    expect(names).toContain("attributes")
    expect(names).toContain("settings")
    expect(names).toContain("annotations")
    // tableName override: json-callout projects as callouts, not callout.
    expect(names).toContain("callouts")
    expect(names).not.toContain("callout")
    // json-chart is not a projected type; no table may appear for it.
    expect(names).not.toContain("chart")

    // rowPath: one row per annotation, not one per block.
    await expect
      .poll(
        async () =>
          (
            (await nabuQuery(
              page,
              "select id from annotations where file = 'p2-doc.md'"
            )) as unknown[]
          ).length,
        { timeout: 30_000 }
      )
      .toBe(2)
  }
)

test(
  "scalars, nested objects and arrays project per the documented type mapping",
  { tag: ["@stack"] },
  async ({ page, project }) => {
    await project.seed(
      "p3-doc.md",
      `# P3 doc\n\nAutonomy at work matters here.\n\n${P3_ATTRIBUTES}\n\n` +
        "```json-annotations\n" +
        JSON.stringify({ annotations: p3Annotations }, null, "\t") +
        "\n```\n"
    )
    await openDocument(page, project, "p3-doc.md")

    const columnTypes = async (table: string): Promise<Record<string, string>> => {
      const rows = (await nabuQuery(
        page,
        `select column_name, data_type from information_schema.columns where table_name = '${table}'`
      )) as { column_name: string; data_type: string }[]
      return Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]))
    }

    // Scalars and typed scalars become columns.
    const attributes = await columnTypes("attributes")
    expect(attributes.date).toBe("DATE")
    expect(attributes.type).toBe("VARCHAR")
    // Array of strings becomes a typed array column.
    expect(attributes.tags).toBe("VARCHAR[]")

    // Nested objects flatten to prefixed columns.
    const annotations = await columnTypes("annotations")
    expect(annotations.locked).toBe("BOOLEAN")
    expect(annotations.vote_find_found).toBe("INTEGER")
    expect(annotations.vote_find_missed).toBe("INTEGER")
    expect(annotations.vote_review).toBe("VARCHAR")

    // Arrays of objects become child tables keyed by file.
    const settingsTags = await columnTypes("settings_tags")
    expect(settingsTags.file).toBe("VARCHAR")
    expect(settingsTags.label).toBe("VARCHAR")

    // Array of numbers becomes FLOAT[] (embeddings in the files table).
    const files = await columnTypes("files")
    expect(files.embedding).toBe("FLOAT[]")
    expect(files.chunkStart).toBe("INTEGER")

    // And the data lands typed, not stringly.
    await expect
      .poll(
        async () =>
          (await nabuQuery(
            page,
            "select vote_find_found, vote_find_missed, vote_review, locked from annotations where file = 'p3-doc.md'"
          )) as Record<string, unknown>[],
        { timeout: 30_000 }
      )
      .toHaveLength(1)
    // Arrays and dates stringified in-database: the browser bridge hands Arrow
    // vectors back for list columns, which do not JSON-serialize readably.
    const [row] = (await nabuQuery(
      page,
      "select vote_find_found, vote_find_missed, vote_review, locked, array_to_string(tags, ',') as tags_str, strftime(date, '%Y-%m-%d') as date_str from annotations join attributes using (file) where file = 'p3-doc.md'"
    )) as Record<string, unknown>[]
    expect(Number(row.vote_find_found)).toBe(2)
    expect(Number(row.vote_find_missed)).toBe(1)
    expect(row.vote_review).toBe("E2E-P3-REVIEW")
    expect(row.locked).toBe(true)
    expect(row.tags_str).toBe("e2e-p3,second-tag")
    expect(row.date_str).toBe("2024-03-05")
  }
)
