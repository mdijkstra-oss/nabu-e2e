import { test, expect } from "../helpers/fixtures"
import { interceptWs, openDocFromSidebar, showDocFilter } from "../helpers/sync"

const MESSY = [
  "# Y6 messy",
  "",
  "",
  "line with trailing   ",
  "- alpha",
  "- beta",
  "",
  "",
  "",
  "tail   ",
  "",
  "",
].join("\n")

const NORMALIZED = "# Y6 messy\n\nline with trailing\n* alpha\n* beta\n\ntail\n"

test("a file pushed by the server lands normalized exactly like a local write", { tag: ["@Y6"] }, async ({ page, project }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  // Seeded raw through the storage API: the app only ever sees it arrive over
  // the websocket, so whatever "Copy raw" shows is what the sync applied.
  await project.seed("y6-messy.md", MESSY)
  await project.open(page)

  await openDocFromSidebar(page, "Y6-Messy", "line with trailing")
  // The header's trailing icon button opens the document menu.
  await page.locator("div.shadow-header-divider button").last().click()
  await page.getByText("Copy raw", { exact: true }).click()

  const raw = await page.evaluate(() => navigator.clipboard.readText())
  // Boot's topic assignment may have appended a json-attributes block; the
  // prose above it must be byte-for-byte the normalized form.
  expect(raw.startsWith(NORMALIZED)).toBe(true)
  expect(raw).not.toContain("- alpha")
  expect(raw).not.toContain("   \n")
  expect(raw).not.toContain("\n\n\n")
})

test("a corrupting server write throws and never lands in the store", { tag: ["@Y6"] }, async ({ page, project }) => {
  const corruptionErrors: string[] = []
  page.on("console", (msg) => {
    if (msg.type() === "error" && msg.text().includes("[file-store]")) {
      corruptionErrors.push(msg.text())
    }
  })

  const ws = await interceptWs(page)
  await project.open(page)

  // Balanced fences, but the json-* block does not parse: structural
  // validation must reject the write. The control file sorts after it, so its
  // arrival proves the corrupt command was delivered first.
  await project.seed(
    "y6-a-corrupt.md",
    "# Y6 corrupt\n\n```json-attributes\n{ definitely not json\n```\n"
  )
  await project.seed("y6-z-control.md", "# Y6 control\n\nA well-formed sibling.\n")
  ws.sever()

  await showDocFilter(page, "Y6")
  await expect(page.getByText("Y6-Z-Control", { exact: true })).toBeVisible()
  await expect(page.getByText("Y6-A-Corrupt", { exact: true })).toHaveCount(0)

  expect(corruptionErrors.length).toBeGreaterThan(0)
  expect(corruptionErrors.join("\n")).toContain("y6-a-corrupt.md")
})
