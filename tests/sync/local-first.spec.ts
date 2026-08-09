import { test, expect, nabuQuery } from "../helpers/fixtures"
import { captureCommands, drainBootWrites, editor, typeIntoEditor } from "../helpers/sync"

test("typing renders locally and SQL answers without a storage round trip", { tag: ["@Y1"] }, async ({ page, project }) => {
  await project.open(page)
  await drainBootWrites(page)

  // Warm the DuckDB test hook while timers are still real.
  await expect
    .poll(async () => ((await nabuQuery(page, "select * from files limit 5")) as unknown[]).length, {
      timeout: 30_000,
    })
    .toBeGreaterThan(0)

  const commands = await captureCommands(page, project.id)
  // Frozen clock: the 500ms persist debounce can never fire, so any request
  // seen below would be a round trip the edit or query depended on.
  await page.clock.install()

  await typeIntoEditor(page, " E2E-Y1-LOCAL-EDIT")
  await expect(editor(page)).toContainText("E2E-Y1-LOCAL-EDIT", { timeout: 2_000 })

  // Let the editor listener (200ms) flush into the store but stay inside the
  // 500ms persist window: the edit is applied locally, still nothing sent.
  await page.clock.runFor(300)

  const rows = (await nabuQuery(page, "select * from files limit 5")) as unknown[]
  expect(rows.length).toBeGreaterThan(0)

  expect(commands).toEqual([])
})
