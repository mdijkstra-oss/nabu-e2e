import { test, expect } from "../helpers/fixtures"
import {
  captureCommands,
  editor,
  interceptWs,
  openDocFromSidebar,
  typeIntoEditor,
  writesTo,
} from "../helpers/sync"
import { readVolumeFile } from "../../harness/volume"

interface OrphanWarning {
  text: string
  args: unknown[]
}

test("boot resolves out-of-order references and audits only the genuinely dangling", { tag: ["@Y7"] }, async ({ page, project }) => {
  const warnings: OrphanWarning[] = []
  page.on("console", (msg) => {
    if (!msg.text().includes("[refs] orphaned at boot")) return
    const entry: OrphanWarning = { text: msg.text(), args: [] }
    warnings.push(entry)
    void Promise.all(msg.args().map((a) => a.jsonValue().catch(() => null))).then((vals) => {
      entry.args = vals
    })
  })

  // a-early.md arrives first (commands are sorted by name) and references one
  // id defined in the later z-defs.md and one id defined nowhere.
  await project.seed(
    "a-early.md",
    '# Early\n\nResolved later: "code-9def1234". Dangling forever: "code-9zzzzzzz".\n'
  )
  await project.seed("z-defs.md", '# Defs\n\n```json-e2e\n{"id": "code-9def1234"}\n```\n')

  await project.open(page)

  await expect.poll(() => warnings.length, { timeout: 20_000 }).toBeGreaterThan(0)
  const flat = warnings.map((w) => w.text + " " + JSON.stringify(w.args)).join("\n")
  expect(flat).toContain("a-early.md")
  expect(flat).toContain("code-9zzzzzzz")
  // The reference whose definition arrived, later in sort order, resolved and
  // is not reported.
  expect(flat).not.toContain("code-9def1234")
})

test("mid-session references are marked pending, resolve on arrival, and markers never reach server or disk", { tag: ["@Y7"] }, async ({ page, project }) => {
  const ws = await interceptWs(page)
  await project.open(page)
  const commands = await captureCommands(page, project.id)

  await project.seed(
    "y7-ref.md",
    '# Y7 ref\n\nProse to edit.\n\n```json-e2e\n{"code": "code-8dangler"}\n```\n'
  )
  ws.sever()
  await openDocFromSidebar(page, "Y7-Ref", "Prose to edit.")

  // The id has no definition yet: the store marks the reference pending.
  await expect(editor(page)).toContainText("#[code-8dangler]")

  // A local edit persists the file; the marker must be stripped on the way out.
  await typeIntoEditor(page, " E2E-Y7-EDIT")
  await expect
    .poll(() => writesTo(commands, "y7-ref.md").length, { timeout: 15_000 })
    .toBeGreaterThan(0)
  for (const write of writesTo(commands, "y7-ref.md")) {
    expect(write.content).not.toContain("#[")
    expect(write.content).toContain('"code-8dangler"')
  }

  await expect
    .poll(() => readVolumeFile(`${project.id}/y7-ref.md`), { timeout: 15_000 })
    .toContain("E2E-Y7-EDIT")
  const onDisk = await readVolumeFile(`${project.id}/y7-ref.md`)
  expect(onDisk).not.toContain("#[")
  expect(onDisk).toContain('"code-8dangler"')

  // Re-arrival without a definition keeps the reference pending...
  ws.sever()
  await page.waitForTimeout(2_000)
  await expect(editor(page)).toContainText("#[code-8dangler]")

  // ...and it resolves once the defining file arrives.
  await project.seed("y7-def.md", '# Y7 def\n\n```json-e2e\n{"id": "code-8dangler"}\n```\n')
  ws.sever()
  await expect(editor(page)).not.toContainText("#[code-8dangler]")
  await expect(editor(page)).toContainText('"code-8dangler"')
})
