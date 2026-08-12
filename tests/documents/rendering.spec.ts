import { expect, nabuQuery, test } from "../helpers/fixtures"
import { listVolumeDir, readVolumeFile } from "../../harness/volume"
import { openDocument, sendChat, waitForReply, extractBlock } from "../helpers/documents"

const CALLOUT_BLOCK = `\`\`\`json-callout
{
	"id": "callout-1d2d2d2d",
	"type": "codebook-code",
	"title": "E2E D2 Callout Title",
	"content": "Callout body content for D2.",
	"color": "blue",
	"collapsed": false
}
\`\`\``

const D2_CHART_BLOCK = `\`\`\`json-chart
{
	"id": "chart-1d2d2d2d",
	"caption": { "label": "E2E D2 chart" },
	"query": "SELECT 'a' AS x, 1 AS y",
	"spec": { "type": "bar", "x": "x", "y": "y", "color": "blue" }
}
\`\`\``

const D2_ATTRIBUTES_BLOCK = `\`\`\`json-attributes
{
	"date": "2024-03-05"
}
\`\`\``

const D3_QUERY = "SELECT color AS x, count(*)::INT AS n FROM annotations GROUP BY color"

const D3_CHART_BLOCK = `\`\`\`json-chart
{
	"id": "chart-1d3d3d3d",
	"caption": { "label": "E2E D3 chart" },
	"query": "${D3_QUERY}",
	"spec": { "type": "bar", "x": "x", "y": "n", "color": "blue" }
}
\`\`\``

test(
  "a project is markdown files opened in a block-based WYSIWYG editor",
  { tag: ["@D1"] },
  async ({ page, project }) => {
    await openDocument(page, project, "interview-anna.md")

    // Block-based WYSIWYG: a contenteditable ProseMirror surface rendering the
    // heading as a heading, not as markdown syntax.
    const editor = page.locator('[data-file-path="interview-anna.md"] .ProseMirror')
    await expect(editor).toBeVisible()
    await expect(editor).toHaveAttribute("contenteditable", "true")
    await expect(editor.locator("h1", { hasText: "Interview with Anna" })).toBeVisible()
    await expect(editor).not.toContainText("# Interview with Anna")

    // Every document in the store is a Markdown file — nothing else on disk.
    await expect
      .poll(async () => (await listVolumeDir(project.id)).length, { timeout: 30_000 })
      .toBeGreaterThan(0)
    const files = await listVolumeDir(project.id)
    expect(files.filter((f) => !f.endsWith(".md"))).toEqual([])
  }
)

test(
  "registered JSON blocks render as their visual form, not raw JSON",
  { tag: ["@D2"] },
  async ({ page, project }) => {
    await project.seed(
      "d2-blocks.md",
      `# D2 blocks\n\nSome prose before the blocks.\n\n${CALLOUT_BLOCK}\n\n${D2_CHART_BLOCK}\n\n${D2_ATTRIBUTES_BLOCK}\n`
    )
    await openDocument(page, project, "d2-blocks.md")

    // Callout: rendered card with its title, no raw JSON anywhere in the DOM.
    const callout = page.locator('[data-id="callout-1d2d2d2d"]')
    await expect(callout).toBeVisible()
    await expect(callout.getByText("E2E D2 Callout Title")).toBeVisible()
    await expect(page.getByText('"codebook-code"')).toHaveCount(0)

    // Chart: drawn as an SVG figure with its numbered caption.
    const chart = page.locator('[data-id="chart-1d2d2d2d"]')
    await expect(chart).toBeVisible()
    await expect(chart.locator("svg").first()).toBeVisible({ timeout: 30_000 })
    await expect(chart.getByText("Figure 1: E2E D2 chart")).toBeVisible()
    await expect(page.getByText('"query"')).toHaveCount(0)

    // Attributes: its visual form is the header date, and the block itself stays hidden —
    // as does every other block the app stores in the document, the region detector's
    // among them. What matters is that none of them is rendered, not how many there are.
    await expect(page.getByText("Mar 5, 2024")).toBeVisible()
    await expect(page.locator(".hidden-block")).not.toHaveCount(0)
    await expect(page.locator(".hidden-block:visible")).toHaveCount(0)
  }
)

test(
  "chart blocks store the query, so a corpus change redraws the figure without editing the block",
  { tag: ["@D3"] },
  async ({ page, project }) => {
    await project.seed("d3-chart.md", `# D3 chart doc\n\n${D3_CHART_BLOCK}\n`)
    await project.seed(
      "d3-source.md",
      "# D3 source\n\nRemote work changed everything for this participant.\n"
    )
    await openDocument(page, project, "d3-chart.md", { showQueryResults: true })

    // No annotations exist yet: the drawn chart is empty.
    const chart = page.locator('[data-id="chart-1d3d3d3d"]')
    await expect(chart).toBeVisible()
    await expect(chart.getByText("No data")).toBeVisible({ timeout: 30_000 })

    const blockBefore = extractBlock(await readVolumeFile(`${project.id}/d3-chart.md`), "json-chart")
    expect(blockBefore).toContain(D3_QUERY)

    // The agent annotates a *different* document; the open chart must redraw.
    await sendChat(page, "Please annotate the source document. E2E-D3-ANNOTATE")
    await waitForReply(page, "E2E-D3-DONE")

    await expect(chart.getByText("Query results (1 rows)")).toBeVisible({ timeout: 30_000 })
    await expect(chart.getByText("No data")).toHaveCount(0)
    await expect(chart.locator("svg").first()).toBeVisible()

    // The block on disk still holds the SQL — not the numbers — and is unchanged.
    await expect
      .poll(async () => extractBlock(await readVolumeFile(`${project.id}/d3-chart.md`), "json-chart"), {
        timeout: 15_000,
      })
      .toBe(blockBefore)

    // Sanity: the corpus change that redrew the chart is a real row now.
    const rows = (await nabuQuery(
      page,
      "select reason from annotations where file = 'd3-source.md'"
    )) as { reason: string }[]
    expect(rows.map((r) => r.reason)).toContain("E2E-D3-REASON")
  }
)
