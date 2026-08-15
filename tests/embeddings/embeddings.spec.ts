import { expect, nabuQuery, test } from "../helpers/fixtures"
import {
  advanceUntil,
  embeddingsBody,
  embeddingsEntries,
  inputsOf,
  maxSeq,
  padProse,
  parseCompanionMarkdown,
  readCompanion,
} from "../helpers/embeddings"
import { listVolumeDir } from "../../harness/volume"
import { sendChat } from "../helpers/documents"

const BASE_COMPANIONS = [
  "field-notes.embeddings.hidden.md",
  "interview-anna.embeddings.hidden.md",
  "interview-bram.embeddings.hidden.md",
]

// One distinctive phrase per base-corpus file, to pin that none of them re-embed.
const BASE_PHRASES = ["Recurring themes", "graphic designer", "support engineer"]

// Chunk geometry: boundaries fall between sentences and are chosen by hashing the text
// before them, so a chunk count follows from a document's length only on average — a unit
// runs about 900 characters. The builders below are sized to clear the counts these tests
// need with room to spare, rather than to land on an exact boundary.

const E1_TOKEN = "kaleidowork-e1"
// ~5600 chars -> 4 units; a coda typed at the end lands only in the last one.
const e1Doc = (): string => {
  const head = `The ${E1_TOKEN} anchor E2E-E1-HEAD-ANCHOR opens this document plainly.`
  return `${padProse(E1_TOKEN, head, 5500)} The ${E1_TOKEN} tail closes the document.`
}

const E2_TOKEN = "kaleidowork-e2"
// ~10100 chars -> 7 units; the mid paragraph sits around [5000, 5700], well
// inside the document, so an edit to it touches the units around it and no more.
const e2Doc = (tok: string): string => {
  const head = `The ${E2_TOKEN} anchor E2E-E2-HEAD-ANCHOR opens this document plainly.`
  const before = padProse(E2_TOKEN, head, 5000)
  const mid = Array.from(
    { length: 10 },
    (_, i) => `The ${E2_TOKEN} middle sentence ${i} states ${tok} for the embedding suite.`
  ).join(" ")
  const after = padProse(E2_TOKEN, `${before} ${mid}`, 10000, 50)
  return `${after} The ${E2_TOKEN} anchor E2E-E2-TAIL-ANCHOR closes this document plainly.`
}

test(
  "a settled edit re-embeds only the changed chunks and writes the companion beside the source",
  { tag: ["@stubbed"] },
  async ({ page, project }) => {
    // Sorts before the base corpus, so the project index opens it in the editor.
    await project.seed("a-e1-notes.md", e1Doc())
    await page.clock.install()
    await project.open(page)

    const boot = await project.journal()
    const baseline = maxSeq(boot)
    const bootInputs = inputsOf(embeddingsEntries(boot)).filter((t) => t.includes(E1_TOKEN))
    expect(bootInputs.length).toBeGreaterThanOrEqual(3)

    const editor = page.locator('[contenteditable="true"]').first()
    await expect(editor).toContainText("E2E-E1-HEAD-ANCHOR", { timeout: 30_000 })
    // Clicking past the last line makes the editor itself place the caret at
    // the document end; the DOM-selection collapse alone is synced through a
    // debounced observer (a page timer, frozen by page.clock), so the first
    // typed key could otherwise land wherever a center click had put the caret.
    const editorBox = await editor.boundingBox()
    if (!editorBox) throw new Error("editor has no bounding box")
    await editor.click({ position: { x: editorBox.width - 5, y: editorBox.height - 5 } })
    await page.evaluate(() => {
      const el = document.querySelector('[contenteditable="true"]')
      const sel = window.getSelection()
      if (!el || !sel) throw new Error("no editor or selection")
      sel.selectAllChildren(el)
      sel.collapseToEnd()
    })
    await page.waitForTimeout(150)
    await page.clock.runFor(100)
    await page.keyboard.type(` The ${E1_TOKEN} coda adds E2E-E1-TAIL-EDIT! now.`)
    // Fail fast if the caret raced: the coda must extend the tail sentence.
    await expect(editor).toContainText(
      `tail closes the document. The ${E1_TOKEN} coda adds E2E-E1-TAIL-EDIT! now.`
    )

    const postEntries = await advanceUntil(page, async () => {
      const entries = embeddingsEntries(await project.journal(), baseline)
      return inputsOf(entries).some((t) => t.includes("E2E-E1-TAIL-EDIT!")) ? entries : undefined
    })

    for (const entry of postEntries) {
      const body = embeddingsBody(entry)
      expect(Array.isArray(body.input)).toBe(true)
      expect(typeof body.model).toBe("string")
      expect(typeof body.dimensions).toBe("number")
    }
    // The corpus-sync round (30s debounce, crossed by the clock advances above)
    // embeds type/subject labels through the same endpoint; the claim is about
    // this document's chunks, which its token identifies. A sync round can also
    // catch the coda mid-typing, so every doc re-embed must be the one changed
    // final window (its stable tail sentence, never the head), while only the
    // settled round carries the full marker.
    const postInputs = inputsOf(postEntries)
    const postDocInputs = postInputs.filter((t) => t.includes(E1_TOKEN))
    expect(postDocInputs.length).toBeGreaterThan(0)
    for (const text of postDocInputs) {
      expect(text).toContain("tail closes the document")
      expect(text).not.toContain("E2E-E1-HEAD-ANCHOR")
    }
    expect(postDocInputs.some((t) => t.includes("E2E-E1-TAIL-EDIT!"))).toBe(true)
    for (const text of postInputs) {
      for (const phrase of BASE_PHRASES) expect(text).not.toContain(phrase)
    }

    const companionMd = await advanceUntil(
      page,
      async () => {
        const md = await readCompanion(project.id, "a-e1-notes.md")
        return md?.includes("E2E-E1-TAIL-EDIT!") ? md : undefined
      },
      { stepMs: 1500 }
    )
    const entries = parseCompanionMarkdown(companionMd)
    expect(entries.length).toBe(bootInputs.length)
    expect(entries.some((e) => e.text.includes("E2E-E1-TAIL-EDIT!"))).toBe(true)
    const width = entries[0].embedding.length
    expect(width).toBeGreaterThan(0)
    for (const e of entries) {
      expect(typeof e.hash).toBe("string")
      expect(e.embedding.length).toBe(width)
      expect(e.embedding.every((n) => typeof n === "number")).toBe(true)
      expect(typeof e.chunkStart).toBe("number")
      expect(typeof e.chunkEnd).toBe("number")
    }

    const dir = await listVolumeDir(project.id)
    expect(dir).toContain("a-e1-notes.md")
    expect(dir).toContain("a-e1-notes.embeddings.hidden.md")
  }
)

test(
  "one edited paragraph re-embeds only the two or three overlapping chunks",
  { tag: ["@stubbed"] },
  async ({ page, project }) => {
    const doc = e2Doc("E2E-E2-MID-ORIG!")
    // The edit has to land in the middle of the document, with whole units either side of
    // it, or "only the units around it re-embed" is not what the test is measuring.
    const idx = doc.indexOf("E2E-E2-MID-ORIG!")
    expect(idx).toBeGreaterThan(doc.length * 0.4)
    expect(idx).toBeLessThan(doc.length * 0.6)
    // The e-e2-edit.yaml fixture anchors on these exact sentences.
    expect(doc).toContain("The kaleidowork-e2 middle sentence 0 states E2E-E2-MID-ORIG! for the embedding suite.")
    expect(doc).toContain("The kaleidowork-e2 middle sentence 9 states E2E-E2-MID-ORIG! for the embedding suite.")

    await project.seed("e2-notes.md", doc)
    await page.clock.install()
    await project.open(page)

    const boot = await project.journal()
    const baseline = maxSeq(boot)
    const bootInputs = inputsOf(embeddingsEntries(boot)).filter((t) => t.includes(E2_TOKEN))
    expect(bootInputs.length).toBeGreaterThanOrEqual(6)

    const bootCompanion = await advanceUntil(
      page,
      async () => {
        const md = await readCompanion(project.id, "e2-notes.md")
        return md && parseCompanionMarkdown(md).length >= bootInputs.length ? md : undefined
      },
      { stepMs: 1500 }
    )
    const bootEntries = parseCompanionMarkdown(bootCompanion)

    // The fixture answers this turn with one edit_file call swapping the mid
    // paragraph for a same-length rewrite (ORIG -> EDIT), in-app.
    await sendChat(page, "Apply the paragraph edit E2E-E2-EDIT-TURN please")
    await expect(page.getByText("E2-EDIT-DONE")).toBeVisible({ timeout: 30_000 })

    const postEntries = await advanceUntil(page, async () => {
      const entries = embeddingsEntries(await project.journal(), baseline)
      return inputsOf(entries).some((t) => t.includes("E2E-E2-MID-EDIT!")) ? entries : undefined
    })

    // Same corpus-sync caveat as E1: label embeds may interleave, so the
    // chunk-count claim is scoped to this document's own inputs.
    const postInputs = inputsOf(postEntries)
    const postDocInputs = postInputs.filter((t) => t.includes(E2_TOKEN))
    expect(postDocInputs.length).toBeGreaterThanOrEqual(2)
    expect(postDocInputs.length).toBeLessThanOrEqual(3)
    for (const text of postDocInputs) {
      expect(text).toContain("E2E-E2-MID-EDIT!")
      expect(text).not.toContain("E2E-E2-HEAD-ANCHOR")
      expect(text).not.toContain("E2E-E2-TAIL-ANCHOR")
    }
    for (const text of postInputs) {
      for (const phrase of BASE_PHRASES) expect(text).not.toContain(phrase)
    }

    const postCompanion = await advanceUntil(
      page,
      async () => {
        const md = await readCompanion(project.id, "e2-notes.md")
        return md?.includes("E2E-E2-MID-EDIT!") && !md.includes("E2E-E2-MID-ORIG!") ? md : undefined
      },
      { stepMs: 1500 }
    )
    const postCompanionEntries = parseCompanionMarkdown(postCompanion)

    // Vectors outside the paragraph survive the edit byte-for-byte.
    const untouchedBefore = bootEntries.filter((e) => !e.text.includes("E2E-E2-MID"))
    const untouchedAfter = postCompanionEntries.filter((e) => !e.text.includes("E2E-E2-MID"))
    expect(untouchedAfter.length).toBe(untouchedBefore.length)
    const byHash = new Map(untouchedBefore.map((e) => [e.hash, e]))
    for (const e of untouchedAfter) {
      const before = byHash.get(e.hash)
      expect(before).toBeDefined()
      expect(e.embedding).toEqual(before!.embedding)
    }
  }
)

test(
  "companions and hidden files never get companions of their own",
  { tag: ["@stubbed"] },
  async ({ page, project }) => {
    await project.seed(
      "decoy.hidden.md",
      "A perfectly ordinary paragraph of prose. E2E-E3-HIDDEN-PROSE sits in a hidden file and must never reach the embeddings endpoint."
    )
    await page.clock.install()
    await project.open(page)

    await advanceUntil(
      page,
      async () => {
        const dir = await listVolumeDir(project.id).catch(() => [] as string[])
        return BASE_COMPANIONS.every((n) => dir.includes(n)) || undefined
      },
      { stepMs: 1500 }
    )

    const baseline = maxSeq(await project.journal())
    // The fixture answers this turn with one edit_file call planting the round
    // marker into field-notes.md, in-app, after every companion exists.
    await sendChat(page, "Record the follow-up E2E-E3-EDIT-TURN please")
    await expect(page.getByText("E3-EDIT-DONE")).toBeVisible({ timeout: 30_000 })

    // A sync round demonstrably ran with all companions in place.
    await advanceUntil(page, async () => {
      const entries = embeddingsEntries(await project.journal(), baseline)
      return inputsOf(entries).some((t) => t.includes("E2E-E3-ROUND-MARKER")) || undefined
    })

    const updatedCompanion = await advanceUntil(
      page,
      async () => {
        const md = await readCompanion(project.id, "field-notes.md")
        return md?.includes("E2E-E3-ROUND-MARKER") ? md : undefined
      },
      { stepMs: 1500 }
    )
    expect(updatedCompanion).toContain('"embedding"')

    // The companion rewrite notifies the store again; flush that round too.
    await page.clock.fastForward(6000)
    await new Promise((r) => setTimeout(r, 1000))

    const dir = await listVolumeDir(project.id)
    expect(dir.filter((n) => n.includes(".embeddings.hidden.embeddings.hidden."))).toEqual([])
    expect(dir).not.toContain("decoy.hidden.embeddings.hidden.md")

    const allInputs = inputsOf(embeddingsEntries(await project.journal()))
    expect(allInputs.filter((t) => t.includes("E2E-E3-HIDDEN-PROSE"))).toEqual([])
    expect(
      allInputs.filter((t) => t.includes("json-embeddings") || t.includes('"chunkStart"'))
    ).toEqual([])
  }
)

test(
  "chunk rows carry the source document's path and hash/embedding stay out of the model's schema",
  { tag: ["@stubbed"] },
  async ({ page, project }) => {
    await project.open(page)

    await expect
      .poll(
        async () => ((await nabuQuery(page, "select file from files")) as unknown[]).length,
        { timeout: 30_000 }
      )
      .toBeGreaterThan(0)

    // hash and embedding are queryable, so they are hidden, not absent.
    const rows = (await nabuQuery(
      page,
      "select file, text, hash, embedding from files"
    )) as Record<string, unknown>[]
    for (const row of rows) {
      expect(String(row.file)).toMatch(/\.md$/)
      expect(String(row.file)).not.toContain(".embeddings.hidden")
      expect(typeof row.hash).toBe("string")
      expect(row.embedding).toBeTruthy()
    }
    const filesSeen = [...new Set(rows.map((r) => String(r.file)))]
    expect(filesSeen).toEqual(
      expect.arrayContaining(["field-notes.md", "interview-anna.md", "interview-bram.md"])
    )

    await sendChat(page, "Schema check E2E-E4-SCHEMA-MARKER")
    await expect(page.getByText("E4-SCHEMA-REPLY-OK")).toBeVisible({ timeout: 30_000 })

    const turns = (await project.journal()).filter(
      (e) => e.path === "/qual-coder" && JSON.stringify(e.body).includes("E2E-E4-SCHEMA-MARKER")
    )
    expect(turns.length).toBeGreaterThan(0)
    const body = turns[turns.length - 1].body as {
      input: { role?: string; content?: unknown }[]
    }
    const systemTexts = body.input
      .filter((i) => i.role === "system")
      .map((i) => (typeof i.content === "string" ? i.content : JSON.stringify(i.content)))
    const schemaMsg = systemTexts.find((t) => t.includes("Database schema (DuckDB)"))
    expect(schemaMsg).toBeTruthy()

    const schemaText = schemaMsg!.split("Database schema (DuckDB):\n\n")[1]
    const filesBlock = schemaText.split("\n\n").find((b) => b.split("\n")[0].trim() === "files")
    expect(filesBlock).toBeTruthy()
    const columns = filesBlock!
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(" ")[0])
    expect(columns).toContain("file")
    expect(columns).toContain("text")
    expect(columns).toContain("chunkStart")
    expect(columns).not.toContain("hash")
    expect(columns).not.toContain("embedding")
  }
)

test(
  "a changed embeddings width is detected and the corpus re-embeds",
  { tag: ["@stubbed"] },
  async ({ page, project }) => {
    test.setTimeout(300_000)
    await project.open(page)

    const bootEmbeddings = embeddingsEntries(await project.journal())
    expect(bootEmbeddings.length).toBeGreaterThan(0)
    for (const e of bootEmbeddings) expect(embeddingsBody(e).dimensions).toBe(1024)

    // Companions must be on the server before the reload has anything to diff.
    await expect
      .poll(async () => listVolumeDir(project.id), { timeout: 30_000 })
      .toEqual(expect.arrayContaining(BASE_COMPANIONS))

    // Control: reloading at the same width re-embeds nothing, so the requests
    // after the override are the mismatch detection and not a boot artifact.
    const baseline1 = maxSeq(await project.journal())
    await project.open(page)
    expect(embeddingsEntries(await project.journal(), baseline1)).toEqual([])

    const baseline2 = maxSeq(await project.journal())
    await page.addInitScript(() => {
      localStorage.setItem("nabu-e2e-env", JSON.stringify({ VITE_EMBEDDINGS_DIMENSIONS: "128" }))
    })
    await project.open(page)

    const post = embeddingsEntries(await project.journal(), baseline2)
    expect(post.length).toBeGreaterThan(0)
    for (const e of post) expect(embeddingsBody(e).dimensions).toBe(128)
    const postText = inputsOf(post).join("\n")
    expect(postText).toContain("graphic designer") // interview-anna.md
    expect(postText).toContain("support engineer") // interview-bram.md
    expect(postText).toContain("Recurring themes") // field-notes.md

    await expect
      .poll(
        async () => {
          const md = await readCompanion(project.id, "interview-anna.md")
          return md ? (parseCompanionMarkdown(md)[0]?.embedding.length ?? 0) : 0
        },
        { timeout: 30_000 }
      )
      .toBe(128)
  }
)

test(
  "a changed embeddings model goes undetected and nothing re-embeds",
  { tag: ["@stubbed"] },
  async ({ page, project }) => {
    test.setTimeout(240_000)
    await project.open(page)

    const bootEmbeddings = embeddingsEntries(await project.journal())
    expect(bootEmbeddings.length).toBeGreaterThan(0)
    for (const e of bootEmbeddings) expect(embeddingsBody(e).model).toBe("text-embedding-3-large")

    await expect
      .poll(async () => listVolumeDir(project.id), { timeout: 30_000 })
      .toEqual(expect.arrayContaining(BASE_COMPANIONS))
    const annaBefore = await readCompanion(project.id, "interview-anna.md")
    expect(annaBefore).toBeTruthy()

    const baseline = maxSeq(await project.journal())
    await page.addInitScript(() => {
      localStorage.setItem(
        "nabu-e2e-env",
        JSON.stringify({ VITE_EMBEDDINGS_MODEL: "text-embedding-e2e-changed" })
      )
    })
    await project.open(page)

    // The boot gate awaits the initial sync run, so post-boot silence is
    // decisive; the extra 6.5s flushes any debounced follow-up round. This is
    // the documented limitation (nabu-frontend README): a changed model is not
    // detected and stale companions must be pruned by hand.
    await new Promise((r) => setTimeout(r, 6500))
    expect(embeddingsEntries(await project.journal(), baseline)).toEqual([])
    expect(await readCompanion(project.id, "interview-anna.md")).toBe(annaBefore)
  }
)
