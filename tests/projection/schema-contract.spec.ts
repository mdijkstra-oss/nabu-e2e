import { expect, nabuQuery, test } from "../helpers/fixtures"
import { sendChat, waitForReply, schemaMessageOf } from "../helpers/documents"

interface DescribedTable {
  name: string
  columns: string[]
}

const parseSchemaMessage = (content: string): DescribedTable[] => {
  const body = content.split("Database schema (DuckDB):")[1] ?? ""
  return body
    .split("\n\n")
    .map((chunk) => chunk.split("\n").filter((l) => l.trim().length > 0))
    .filter((lines) => lines.length > 0)
    .map((lines) => ({
      name: lines[0].trim(),
      columns: lines.slice(1).map((l) => l.trim().split(/\s+/)[0]),
    }))
}

// The files table's hash and embedding columns are deliberately hidden from the
// model (documented in 01); the tables themselves must still match exactly.
const HIDDEN_COLUMNS: Record<string, string[]> = { files: ["hash", "embedding"] }

test(
  "the DDL sent to the agent names exactly the tables that exist",
  { tag: ["@P4"] },
  async ({ page, project }) => {
    await project.open(page)

    await sendChat(page, "What tables can you query? E2E-P4-SCHEMA")
    await waitForReply(page, "E2E-P4-DONE")

    const entries = (await project.journal()).filter(
      (e) => e.path === "/qual-coder" && JSON.stringify(e.body).includes("E2E-P4-SCHEMA")
    )
    expect(entries.length).toBeGreaterThan(0)
    const schemaText = schemaMessageOf(entries[entries.length - 1])
    expect(schemaText).not.toBeNull()

    const described = parseSchemaMessage(schemaText as string)
    expect(described.length).toBeGreaterThan(0)

    const actualTables = (
      (await nabuQuery(
        page,
        "select table_name from information_schema.tables where table_schema = 'main'"
      )) as { table_name: string }[]
    ).map((t) => t.table_name)

    // Exactly the same set of tables, both directions — no drift.
    expect(new Set(described.map((t) => t.name))).toEqual(new Set(actualTables))

    // Every described column exists as described; only the documented hidden
    // columns may exist without being shown.
    const actualColumns = (await nabuQuery(
      page,
      "select table_name, column_name from information_schema.columns"
    )) as { table_name: string; column_name: string }[]
    const byTable = new Map<string, Set<string>>()
    for (const { table_name, column_name } of actualColumns) {
      if (!byTable.has(table_name)) byTable.set(table_name, new Set())
      byTable.get(table_name)?.add(column_name)
    }

    for (const table of described) {
      const actual = byTable.get(table.name)
      expect(actual, `table ${table.name} missing from database`).toBeDefined()
      for (const col of table.columns) {
        expect(actual?.has(col), `${table.name}.${col} described but missing`).toBe(true)
      }
      const undescribed = [...(actual ?? [])].filter(
        (c) => !table.columns.includes(c) && !(HIDDEN_COLUMNS[table.name] ?? []).includes(c)
      )
      expect(undescribed, `${table.name} has columns the agent was never told about`).toEqual([])
    }
  }
)
