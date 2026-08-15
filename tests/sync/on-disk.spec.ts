import { test, expect } from "../helpers/fixtures"
import { drainBootWrites, typeIntoEditor } from "../helpers/sync"
import { listVolumeDir, readVolumeFile } from "../../harness/volume"

test("the project directory on disk is plain markdown", { tag: ["@stack"] }, async ({ page, project }) => {
  await project.open(page)
  await drainBootWrites(page)

  await typeIntoEditor(page, " E2E-Y8-ON-DISK")

  await expect
    .poll(() => readVolumeFile(`${project.id}/field-notes.md`), { timeout: 15_000 })
    .toContain("E2E-Y8-ON-DISK")

  const onDisk = await readVolumeFile(`${project.id}/field-notes.md`)
  // Readable markdown, byte for byte: the heading, the seeded prose, and the
  // edit, with no envelope or encoding around them.
  expect(onDisk.startsWith("# Field notes\n")).toBe(true)
  // The typed marker lands in the first paragraph; this one stays untouched.
  expect(onDisk).toContain("monthly office days")
  expect(onDisk).not.toContain("#[")
  expect(onDisk).not.toMatch(/<\/?(html|body|div|span|p)\b/i)
  expect(onDisk.endsWith("\n")).toBe(true)

  const entries = await listVolumeDir(project.id)
  expect(entries.length).toBeGreaterThanOrEqual(5)
  for (const entry of entries) {
    expect(entry, `unexpected non-markdown entry ${entry}`).toMatch(/\.md$/)
  }
  expect(entries).toContain("field-notes.md")
  expect(entries).toContain("interview-anna.md")
  expect(entries).toContain("interview-bram.md")
})
