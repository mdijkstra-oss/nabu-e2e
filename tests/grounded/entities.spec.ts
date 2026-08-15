import { test, expect } from "../helpers/fixtures"
import {
  CALLOUT_ID,
  CALLOUT_TITLE,
  CALLOUT_COLOR,
  CODEBOOK_DOC,
  SETTINGS_DOC,
  TAG_COLOR,
  awaitReply,
  sendChat,
} from "../helpers/grounded"

test(
  "a resolvable callout id and filename render as pills with the entity's name and color, linked to their definitions",
  { tag: ["@stubbed"] },
  async ({ page, project }) => {
    await project.seed("codebook.md", CODEBOOK_DOC)
    await project.seed("settings.hidden.md", SETTINGS_DOC)
    await project.open(page)

    await sendChat(page, "Where is the strongest theme? E2E-G1-ENTITIES")
    const body = await awaitReply(page, "G1-REPLY-END")

    const calloutPill = body.locator(`a[href*="entity=${CALLOUT_ID}"]`)
    await expect(calloutPill).toHaveText(CALLOUT_TITLE)
    await expect(calloutPill).toHaveAttribute("style", new RegExp(`--${CALLOUT_COLOR}-11`))
    await expect(calloutPill).toHaveAttribute(
      "href",
      new RegExp(`/project/${project.id}/file/codebook\\.md\\?entity=${CALLOUT_ID}$`)
    )
    await expect(body).not.toContainText(CALLOUT_ID)

    // toDisplayName title-cases the filename; that display name is the file's name.
    const filePill = body.locator('a[href$="/file/interview-anna.md"]')
    await expect(filePill).toHaveText("Interview-Anna")
    await expect(filePill).toHaveAttribute("style", /--color-brand-/)

    await calloutPill.click()
    await expect(page).toHaveURL(new RegExp(`/file/codebook\\.md\\?entity=${CALLOUT_ID}`))
  }
)

test(
  "a resolvable #tag renders as a pill with the tag's name and color, unlinked — its definition is hidden",
  { tag: ["@stubbed"] },
  async ({ page, project }) => {
    await project.seed("codebook.md", CODEBOOK_DOC)
    await project.seed("settings.hidden.md", SETTINGS_DOC)
    await project.open(page)

    await sendChat(page, "Where is the strongest theme? E2E-G1-ENTITIES")
    const body = await awaitReply(page, "G1-REPLY-END")

    const tagPill = body.locator("a").filter({ hasText: "Morale" })
    await expect(tagPill).toHaveText("Morale")
    await expect(tagPill).toHaveAttribute("style", new RegExp(`--${TAG_COLOR}-11`))
    await expect(body).not.toContainText("#morale")
    // Tag definitions live in the hidden settings file, not user-navigable.
    await expect(tagPill).toHaveAttribute("href", "")
  }
)

test(
  "an id that resolves to nothing is left exactly as written and never linked",
  { tag: ["@stubbed"] },
  async ({ page, project }) => {
    await project.open(page)

    // The scripted answer carries the dangling id alongside a tool call — the
    // loop's rejection guard only re-asks tool-call-free responses, so this is
    // how an unresolvable id reaches the rendered answer at all.
    await sendChat(page, "What backs this up? E2E-G2-UNRESOLVED")
    await awaitReply(page, "G2-TURN-DONE")

    const body = page.locator("div.prose").filter({ hasText: "G2-REPLY-END" }).last()
    await expect(body).toContainText("callout-9zzzzzz9")
    await expect(body.locator("a")).toHaveCount(0)
  }
)

test(
  "a filename that resolves to nothing keeps its text as written, never links, and is styled as missing",
  { tag: ["@stubbed"] },
  async ({ page, project }) => {
    await project.open(page)

    await sendChat(page, "Which document covers this? E2E-G2-MISSING-FILE")
    const body = await awaitReply(page, "G2-FILE-REPLY-END")

    await expect(body.locator("a")).toHaveCount(0)
    const missing = body.locator("[data-missing-ref]")
    await expect(missing).toHaveText("ghost-diary.md")
    await expect(missing).toHaveClass(/decoration-dashed/)
  }
)

test(
  "a redundant name next to its id is absorbed into a single link",
  { tag: ["@stubbed"] },
  async ({ page, project }) => {
    await project.seed("codebook.md", CODEBOOK_DOC)
    await project.open(page)

    await sendChat(page, "Where does it cluster? E2E-G3-DUP")
    const body = await awaitReply(page, "G3-REPLY-END")

    const pill = body.locator(`a[href*="entity=${CALLOUT_ID}"]`)
    await expect(pill).toHaveText(CALLOUT_TITLE)
    await expect(body).not.toContainText(CALLOUT_ID)
    // The absorbed duplicate leaves neither a second name nor its parentheses.
    await expect
      .poll(async () => (await body.innerText()).split(CALLOUT_TITLE).length - 1)
      .toBe(1)
    await expect(body).not.toContainText("(")
  }
)
