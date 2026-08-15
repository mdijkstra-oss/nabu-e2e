import { expect, nabuQuery, test } from "../helpers/fixtures"
import { readVolumeFile } from "../../harness/volume"
import { openDocument, sendChat, waitForReply, toolOutputs, extractBlock } from "../helpers/documents"

const D4_CONTENT = "The quick brown fox jumps over the lazy dog.\n"

const D6_CALLOUT = `\`\`\`json-callout
{
	"id": "callout-1d6d6d6d",
	"type": "codebook-code",
	"title": "E2E D6 original",
	"content": "Original callout content.",
	"color": "blue",
	"collapsed": false
}
\`\`\``

const D7_CHART = `\`\`\`json-chart
{
	"id": "chart-1d7d7d7d",
	"caption": { "label": "E2E D7 chart" },
	"query": "SELECT title AS x, 1 AS y FROM callouts",
	"spec": { "type": "bar", "x": "x", "y": "y", "color": "blue" }
}
\`\`\``

const D7_CODEBOOK = `\`\`\`json-callout
{
	"id": "callout-1d7c0de1",
	"type": "codebook-code",
	"title": "E2E D7 code",
	"content": "A code defined in its own file.",
	"color": "green",
	"collapsed": false
}
\`\`\``

test(
  "the same edit lands identically through the editor and through the agent",
  { tag: ["@stubbed"] },
  async ({ page, project }) => {
    await project.seed("d4-agent.md", D4_CONTENT)
    await project.seed("d4-user.md", D4_CONTENT)
    await openDocument(page, project, "d4-user.md")

    // User path: type the sentence at the end of the paragraph in the editor.
    const editor = page.locator('[data-file-path="d4-user.md"] .ProseMirror')
    await editor.getByText("over the lazy dog.").click()
    await page.keyboard.press("End")
    await page.keyboard.type(" E2E-D4-APPENDED-SENTENCE.")

    await expect
      .poll(async () => readVolumeFile(`${project.id}/d4-user.md`), { timeout: 30_000 })
      .toContain("lazy dog. E2E-D4-APPENDED-SENTENCE.")

    // Agent path: the fixture applies the identical edit to d4-agent.md.
    await sendChat(page, "Please edit the other document. E2E-D4-AGENT-EDIT")
    await waitForReply(page, "E2E-D4-DONE")

    await expect
      .poll(async () => readVolumeFile(`${project.id}/d4-agent.md`), { timeout: 30_000 })
      .toContain("lazy dog. E2E-D4-APPENDED-SENTENCE.")

    // Same write path, same normalization: the files converge byte-identical.
    // (Boot classification writes the same attributes into both; poll until settled.)
    await expect
      .poll(
        async () => {
          const agent = await readVolumeFile(`${project.id}/d4-agent.md`)
          const user = await readVolumeFile(`${project.id}/d4-user.md`)
          return agent === user ? "identical" : `--agent--\n${agent}\n--user--\n${user}`
        },
        { timeout: 45_000 }
      )
      .toBe("identical")
  }
)

test(
  "a write producing an invalid block throws before the store and corrupts nothing",
  { tag: ["@stack"] },
  async ({ page, project }) => {
    await project.seed("d5-doc.md", "# D5 doc\n\nSome D5 prose.\n")
    await openDocument(page, project, "d5-doc.md")

    await sendChat(page, "Please set the date. E2E-D5-MALFORMED")
    await waitForReply(page, "E2E-D5-DONE")

    // The tool result the agent got back is the validation refusal.
    await expect
      .poll(async () => toolOutputs(await project.journal()), { timeout: 15_000 })
      .toContain("Patch produces invalid `json-attributes` block")

    // Nothing reached the store: no malformed value on disk, none projected.
    const onDisk = await readVolumeFile(`${project.id}/d5-doc.md`)
    expect(onDisk).not.toContain("not-a-date")
    expect(onDisk).toContain("Some D5 prose.")
    const rows = (await nabuQuery(
      page,
      "select date from attributes where file = 'd5-doc.md' and date is not null"
    )) as unknown[]
    expect(rows).toEqual([])
  }
)

test(
  "changing an immutable field (id) is rejected and the block stays intact",
  { tag: ["@stack"] },
  async ({ page, project }) => {
    await project.seed("d6-doc.md", `# D6 doc\n\n${D6_CALLOUT}\n`)
    await openDocument(page, project, "d6-doc.md")

    await sendChat(page, "Please change the id. E2E-D6-IMMUTABLE")
    await waitForReply(page, "E2E-D6-DONE")

    // The write is refused: either the immutable message or the id-removal guard.
    await expect
      .poll(async () => toolOutputs(await project.journal()), { timeout: 15_000 })
      .toMatch(/immutable|was removed/)

    const onDisk = await readVolumeFile(`${project.id}/d6-doc.md`)
    expect(onDisk).toContain("callout-1d6d6d6d")
    expect(onDisk).toContain("E2E D6 original")
    expect(onDisk).not.toContain("callout-2changed")
    expect(onDisk).not.toContain("E2E-D6-CHANGED")
  }
)

test(
  "a write naming an entity that exists nowhere in the corpus is refused",
  { tag: ["@stack"] },
  async ({ page, project }) => {
    await project.seed("d7-chart.md", `# D7 chart\n\n${D7_CHART}\n`)
    await project.seed("d7-codebook.md", `# D7 codebook\n\n${D7_CODEBOOK}\n`)
    await openDocument(page, project, "d7-chart.md")

    await sendChat(page, "Please point the chart at a code. E2E-D7-BAD-REF")
    await waitForReply(page, "E2E-D7-BAD-DONE")

    await expect
      .poll(async () => toolOutputs(await project.journal()), { timeout: 15_000 })
      .toContain("Unknown entity: callout-9does404")

    const block = extractBlock(await readVolumeFile(`${project.id}/d7-chart.md`), "json-chart")
    expect(block).not.toContain("callout-9does404")
  }
)

test(
  "a write referencing an entity defined in another file passes the corpus check",
  { tag: ["@stack"] },
  async ({ page, project }) => {
    await project.seed("d7-chart.md", `# D7 chart\n\n${D7_CHART}\n`)
    await project.seed("d7-codebook.md", `# D7 codebook\n\n${D7_CODEBOOK}\n`)
    await openDocument(page, project, "d7-chart.md")

    await sendChat(page, "Please point the chart at a code. E2E-D7-GOOD-REF")
    await waitForReply(page, "E2E-D7-GOOD-DONE")

    // callout-1d7c0de1 lives in d7-codebook.md, not in the edited file — the
    // reference resolves against the corpus and the write lands.
    await expect
      .poll(
        async () => extractBlock(await readVolumeFile(`${project.id}/d7-chart.md`), "json-chart"),
        { timeout: 30_000 }
      )
      .toContain("callout-1d7c0de1")
    const journalText = toolOutputs(await project.journal())
    expect(journalText).toContain("Patched `json-chart` block in d7-chart.md")
    expect(journalText).not.toContain("Unknown entity")
  }
)
