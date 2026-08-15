import { expect, nabuQuery, test } from "../helpers/fixtures"
import type { Locator, Page } from "@playwright/test"
import { readVolumeFile } from "../../harness/volume"
import { openDocument, pasteMarkdown } from "../helpers/documents"

const PASTED_TABLE = [
  "| Item | Amount | When |",
  "| --- | --- | --- |",
  "| Coffee | 4.50 | 2026-01-05 |",
  "| Notebook | 12.00 | 2026-02-11 |",
  "| Chair | oops | 2026-03-20 |",
].join("\n")

const COLUMNS = [
  { header: "Item", key: "item", sqlType: "VARCHAR" },
  { header: "Amount", key: "amount", sqlType: "DOUBLE" },
  // `when` is a DuckDB reserved keyword: unquoted it is a syntax error that
  // takes the whole CREATE with it, so the key rule has to land somewhere else.
  { header: "When", key: "when_2", sqlType: "DATE" },
]

const DATE_COLUMN = COLUMNS[2].key

const EXPECTED_ROWS = [
  { item: "Coffee", amount: 4.5, day: "2026-01-05" },
  { item: "Notebook", amount: 12, day: "2026-02-11" },
  { item: "Chair", amount: null, day: "2026-03-20" },
]

const INVALID_CELL = "2:amount"

const rowsOf = async (page: Page, table: string): Promise<unknown[]> =>
  nabuQuery(
    page,
    `select item, amount, strftime(${DATE_COLUMN}, '%Y-%m-%d') as day from ${table} order by day`
  )

const docTableFor = async (page: Page, file: string): Promise<string | null> => {
  const rows = (await nabuQuery(
    page,
    `select table_name from duckdb_tables() where comment like '%${file}%'`
  )) as { table_name: string }[]
  return rows[0]?.table_name ?? null
}

const commentOf = async (page: Page, table: string): Promise<string> => {
  const [row] = (await nabuQuery(
    page,
    `select comment from duckdb_tables() where table_name = '${table}'`
  )) as { comment: string }[]
  return row?.comment ?? ""
}

const columnTypesOf = async (page: Page, table: string): Promise<Record<string, string>> => {
  const rows = (await nabuQuery(page, `describe ${table}`)) as {
    column_name: string
    column_type: string
  }[]
  return Object.fromEntries(rows.map((r) => [r.column_name, r.column_type]))
}

const awaitProjection = async (page: Page, file: string): Promise<string> => {
  await expect.poll(() => docTableFor(page, file), { timeout: 45_000 }).not.toBeNull()
  const table = (await docTableFor(page, file)) as string
  await expect.poll(() => rowsOf(page, table), { timeout: 45_000 }).toHaveLength(3)
  return table
}

const sumOf = async (page: Page, table: string): Promise<number> => {
  const [row] = (await nabuQuery(page, `select sum(amount) as total from ${table}`)) as {
    total: number
  }[]
  return row.total
}

const startNewParagraph = async (page: Page, file: string): Promise<Locator> => {
  const editor = page.locator(`[data-file-path="${file}"] .ProseMirror`)
  await editor.getByText("Notes before the table.").click()
  await page.keyboard.press("End")
  await page.keyboard.press("Enter")
  return editor
}

const PASTE_FILE = "d11-paste.md"

test(
  "a pasted pipe table becomes an editable grid and its own queryable SQL table",
  { tag: ["@stack"] },
  async ({ page, project }) => {
    await project.seed(PASTE_FILE, "# D11 paste\n\nNotes before the table.\n")
    await openDocument(page, project, PASTE_FILE)

    await startNewParagraph(page, PASTE_FILE)
    await pasteMarkdown(page, PASTED_TABLE)

    const grid = page.locator('[data-id^="table-"]')
    await expect(grid).toBeVisible({ timeout: 30_000 })
    await expect(grid.locator("[data-column-header]")).toHaveText(COLUMNS.map((c) => c.header))
    for (const column of COLUMNS) {
      await expect(grid.locator(`[data-column-header="${column.key}"]`)).toHaveCount(1)
    }
    await expect(grid.locator('[data-cell="0:item"] input')).toHaveValue("Coffee")

    // The cell that cannot parse as a number is marked and kept verbatim.
    await expect(grid.locator(`[data-cell="${INVALID_CELL}"][data-invalid]`)).toHaveCount(1)
    await expect(grid.locator(`[data-cell="${INVALID_CELL}"] input`)).toHaveValue("oops")

    const blockId = (await grid.getAttribute("data-id")) as string
    const table = blockId.replace(/-/g, "_")
    expect(await awaitProjection(page, PASTE_FILE)).toBe(table)

    const types = await columnTypesOf(page, table)
    expect(types.file).toBe("VARCHAR")
    for (const column of COLUMNS) expect(types[column.key]).toBe(column.sqlType)

    expect(await rowsOf(page, table)).toEqual(EXPECTED_ROWS)
    expect(await sumOf(page, table)).toBe(16.5)

    const stamped = (await nabuQuery(page, `select distinct file from ${table}`)) as {
      file: string
    }[]
    expect(stamped).toEqual([{ file: PASTE_FILE }])

    expect(await commentOf(page, table)).toBe(`${PASTE_FILE} — 1 cell fails its column type`)

    // No pipe table survives the paste into the saved file.
    await expect
      .poll(() => readVolumeFile(`${project.id}/${PASTE_FILE}`), { timeout: 30_000 })
      .toContain("```json-table")
    expect(await readVolumeFile(`${project.id}/${PASTE_FILE}`)).not.toContain("| Coffee |")

    const cell = grid.locator(`[data-cell="${INVALID_CELL}"] input`)
    await cell.click()
    await cell.fill("20.25")
    await cell.press("Enter")

    await expect.poll(() => sumOf(page, table), { timeout: 45_000 }).toBe(36.75)
    await expect.poll(() => commentOf(page, table), { timeout: 45_000 }).toBe(PASTE_FILE)
  }
)

const IMPORT_FILE = "d11-import.md"

// The project route redirects to the first available file, so "nobody opened it"
// has to be an explicit landing on a different document.
const OTHER_FILE = "interview-anna.md"

test(
  "a document imported with a pipe table is queryable without anyone opening it",
  { tag: ["@stack"] },
  async ({ page, project }) => {
    await project.seed(IMPORT_FILE, `# D11 import\n\n${PASTED_TABLE}\n`)
    await openDocument(page, project, OTHER_FILE)
    await expect(page.locator(`[data-file-path="${OTHER_FILE}"]`)).toBeVisible()
    await expect(page.locator(`[data-file-path="${IMPORT_FILE}"]`)).toHaveCount(0)

    const table = await awaitProjection(page, IMPORT_FILE)
    expect(table).toMatch(/^table_[a-z0-9]+$/)

    expect(await rowsOf(page, table)).toEqual(EXPECTED_ROWS)
    const stamped = (await nabuQuery(page, `select distinct file from ${table}`)) as {
      file: string
    }[]
    expect(stamped).toEqual([{ file: IMPORT_FILE }])

    const onDisk = await readVolumeFile(`${project.id}/${IMPORT_FILE}`)
    expect(onDisk).toContain("```json-table")
    expect(onDisk).not.toContain("| Coffee |")
  }
)
