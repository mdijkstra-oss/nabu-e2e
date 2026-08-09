import { test, expect } from "../helpers/fixtures"
import {
  captureCommands,
  drainBootWrites,
  openDocFromSidebar,
  typeIntoEditor,
  writesTo,
} from "../helpers/sync"

// Editor keystrokes reach the store via the Milkdown listener's 200ms
// debounce, so every keystroke below is followed by runFor(200) before the
// 500ms persist debounce is reasoned about.

test("a typing burst persists as one whole-file write per path, paths independent", { tag: ["@Y2"] }, async ({ page, project }) => {
  await project.open(page)
  await drainBootWrites(page)

  const commands = await captureCommands(page, project.id)
  await page.clock.install()

  // t=0: burst in field-notes.md; its persist timer will fire at ~700.
  await typeIntoEditor(page, " E2E-Y2-ALPHA")
  await page.clock.runFor(250)

  // Keep a second document busy across field-notes' whole persist window.
  await openDocFromSidebar(page, "Interview-Anna", "Anna has worked remotely")
  await typeIntoEditor(page, " E2E-Y2-BRAVO")
  await page.clock.runFor(200)
  for (const ch of ["x", "y", "z"]) {
    await page.keyboard.type(ch)
    await page.clock.runFor(200)
  }

  // field-notes' write fired on schedule even though interview-anna was being
  // typed in the whole time; interview-anna is still inside its own window.
  await expect.poll(() => writesTo(commands, "field-notes.md").length).toBe(1)
  const alpha = writesTo(commands, "field-notes.md")[0]
  expect(alpha.content).toContain("E2E-Y2-ALPHA")
  expect(alpha.content).toContain("# Field notes")
  expect(writesTo(commands, "interview-anna.md")).toEqual([])

  await page.clock.runFor(700)
  await expect.poll(() => writesTo(commands, "interview-anna.md").length).toBe(1)
  const bravo = writesTo(commands, "interview-anna.md")[0]
  // One request for the whole burst, carrying the entire file.
  expect(bravo.content).toContain("E2E-Y2-BRAVOxyz")
  expect(bravo.content).toContain("# Interview with Anna")

  await page.clock.runFor(1000)
  expect(writesTo(commands, "field-notes.md")).toHaveLength(1)
  expect(writesTo(commands, "interview-anna.md")).toHaveLength(1)
})

test("a rename inside the debounce window cancels the pending write instead of racing it", { tag: ["@Y3"] }, async ({ page, project }) => {
  await project.open(page)
  await drainBootWrites(page)

  const commands = await captureCommands(page, project.id)
  await page.clock.install()

  await typeIntoEditor(page, " E2E-Y3-KEEP")
  await page.clock.runFor(250)

  // Rename while field-notes.md still has ~250ms left on its persist timer.
  // The header carries the title button; the sidebar shows the same text.
  await page
    .locator("div.shadow-header-divider")
    .getByRole("button", { name: "Field-Notes" })
    .click()
  await page.getByLabel("Document title").fill("Y3 Renamed")
  await page.keyboard.press("Enter")

  await expect.poll(() =>
    commands.filter((c) => c.action === "RenameFile" && c.path === "field-notes.md").length
  ).toBe(1)
  expect(
    commands.find((c) => c.action === "RenameFile" && c.path === "field-notes.md")?.newPath
  ).toBe("y3_renamed.md")

  await page.clock.runFor(700)
  await expect.poll(() => writesTo(commands, "y3_renamed.md").length).toBe(1)
  expect(writesTo(commands, "y3_renamed.md")[0].content).toContain("E2E-Y3-KEEP")

  await page.clock.runFor(1500)
  // The old path never receives the pending write: a raced write would have
  // recreated field-notes.md on the server after the rename.
  expect(writesTo(commands, "field-notes.md")).toEqual([])
})
