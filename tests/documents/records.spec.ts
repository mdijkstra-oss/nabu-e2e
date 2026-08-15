import { expect, nabuQuery, test } from "../helpers/fixtures"
import { readVolumeFile } from "../../harness/volume"
import { openDocument, sendChat, waitForReply, toolOutputs, extractBlock } from "../helpers/documents"

const D9_PROSE = "# D9 doc\n\nThe participant described their routine in detail.\n"

test(
  "a landed write shows up as typed entries in the session mutation timeline",
  { tag: ["@stack"] },
  async ({ page, project }) => {
    await project.seed("d8-doc.md", "# D8 doc\n\nThe team runs a daily video standup.\n")
    await openDocument(page, project, "d8-doc.md")

    await sendChat(page, "Please annotate this. E2E-D8-EDIT")
    await waitForReply(page, "E2E-D8-DONE")

    // The chat timeline weaves the mutation history in as an "Edits" card with
    // a typed entry (verb + entity kind + label).
    await expect(page.getByText("Edits").first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/Added annotation/).first()).toBeVisible()
    await expect(page.getByText(/daily video standup/).first()).toBeVisible()
  }
)

test(
  "a new record gets an id in the strict <prefix>-[0-9][a-z0-9]{7} format",
  { tag: ["@stack"] },
  async ({ page, project }) => {
    await project.seed("d9-doc.md", D9_PROSE)
    await openDocument(page, project, "d9-doc.md")

    await sendChat(page, "Please annotate this. E2E-D9-FORMAT")
    await waitForReply(page, "E2E-D9-FORMAT-DONE")

    await expect
      .poll(
        async () =>
          (
            (await nabuQuery(
              page,
              "select id from annotations where reason = 'E2E-D9-FORMAT-R'"
            )) as { id: string }[]
          ).length,
        { timeout: 30_000 }
      )
      .toBe(1)
    const [row] = (await nabuQuery(
      page,
      "select id from annotations where reason = 'E2E-D9-FORMAT-R'"
    )) as { id: string }[]
    expect(row.id).toMatch(/^annotation-[0-9][a-z0-9]{7}$/)

    // The generated id is what landed in the file, too. Polled: the write is
    // debounced, so it lands after the row is already queryable.
    await expect
      .poll(async () => await readVolumeFile(`${project.id}/d9-doc.md`).catch(() => ""), {
        timeout: 30_000,
      })
      .toContain("E2E-D9-FORMAT-R")
  }
)

test(
  "the same record written with different field orders is normalized to one shape",
  { tag: ["@stack"] },
  async ({ page, project }) => {
    await project.seed("d9-a.md", D9_PROSE)
    await project.seed("d9-b.md", D9_PROSE)
    await openDocument(page, project, "d9-a.md")

    // One reply, two tool calls: identical annotation, field order swapped.
    await sendChat(page, "Please annotate both files. E2E-D9-ORDER")
    await waitForReply(page, "E2E-D9-ORDER-DONE")

    const blockKeys = async (file: string): Promise<string[] | null> => {
      const raw = await readVolumeFile(`${project.id}/${file}`).catch(() => "")
      const block = extractBlock(raw, "json-annotations")
      if (!block) return null
      const parsed = JSON.parse(block) as { annotations: Record<string, unknown>[] }
      const item = parsed.annotations.find((a) => a.reason === "E2E-D9-ORDER-R")
      return item ? Object.keys(item) : null
    }

    await expect.poll(() => blockKeys("d9-a.md"), { timeout: 30_000 }).not.toBeNull()
    await expect.poll(() => blockKeys("d9-b.md"), { timeout: 30_000 }).not.toBeNull()

    // Normalized field order means both blocks carry the keys in the same order.
    const keysA = await blockKeys("d9-a.md")
    const keysB = await blockKeys("d9-b.md")
    expect(keysA).toEqual(keysB)
  }
)

test(
  "a block type with allowedFiles is refused outside its file",
  { tag: ["@stack"] },
  async ({ page, project }) => {
    await project.seed("d10-doc.md", "# D10 doc\n\nOrdinary prose here.\n")
    await openDocument(page, project, "d10-doc.md")

    await sendChat(page, "Please add a tag definition here. E2E-D10-SETTINGS")
    await waitForReply(page, "E2E-D10-DONE")

    await expect
      .poll(async () => toolOutputs(await project.journal()), { timeout: 15_000 })
      .toContain("can only exist in: settings.hidden.md")

    const onDisk = await readVolumeFile(`${project.id}/d10-doc.md`)
    expect(onDisk).not.toContain("json-settings")
    expect(onDisk).not.toContain("e2e-d10")
  }
)
