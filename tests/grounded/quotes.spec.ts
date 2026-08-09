import { test, expect } from "../helpers/fixtures"
import {
  DIARY_DOC,
  OTHER_NOTES_DOC,
  VENDING_SENTENCE,
  awaitReply,
  inViewport,
  openDocument,
  sendChat,
} from "../helpers/grounded"

const spotlightSpan = (page: import("@playwright/test").Page) =>
  page.locator('[data-spotlight="true"]').first()

test(
  "an exact curly-quoted passage from the open document links, and clicking scrolls to and underlines it",
  { tag: ["@G4"] },
  async ({ page, project }) => {
    await project.seed("diary.md", DIARY_DOC)
    await project.open(page)
    await openDocument(page, project.id, "diary.md")

    await sendChat(page, "Quote the standup detail. E2E-G4-EXACT")
    const body = await awaitReply(page, "G4-REPLY-END")

    const quoteLink = body.locator('a[href*="spotlight="]')
    await expect(quoteLink).toHaveCount(1)
    await expect(quoteLink).toContainText("the afternoon standup felt shorter")

    await quoteLink.click()
    await expect(page).toHaveURL(/\/file\/diary\.md\?spotlight=/)

    const underlined = spotlightSpan(page)
    await expect(underlined).toBeVisible()
    await expect(underlined).toHaveAttribute("style", /border-bottom/)
    await expect(underlined).toContainText("afternoon standup felt shorter")
    await expect.poll(() => inViewport(page, underlined), { timeout: 15_000 }).toBe(true)
  }
)

test(
  "a five-plus-token quote at the 90% in-order floor still links and underlines the source passage",
  { tag: ["@G4"] },
  async ({ page, project }) => {
    await project.seed("diary.md", DIARY_DOC)
    await project.open(page)
    await openDocument(page, project.id, "diary.md")

    await sendChat(page, "Quote the review detail. E2E-G4-FUZZY")
    const body = await awaitReply(page, "G4-FUZZY-REPLY-END")

    const quoteLink = body.locator('a[href*="spotlight="]')
    await expect(quoteLink).toHaveCount(1)

    await quoteLink.click()
    await expect(page).toHaveURL(/\/file\/diary\.md\?spotlight=/)

    // The first qualifying 90% window may start a token early, so the
    // decoration can split across paragraphs — assert on all spans joined.
    const spans = page.locator('[data-spotlight="true"]')
    await expect(spans.first()).toBeVisible()
    await expect(spans.last()).toHaveAttribute("style", /border-bottom/)
    await expect
      .poll(async () => (await spans.allInnerTexts()).join(" "))
      .toContain("code review")
    await expect.poll(() => inViewport(page, spans.last()), { timeout: 15_000 }).toBe(true)
  }
)

test(
  "a quote that matches nothing stays plain quoted text with no link",
  { tag: ["@G5"] },
  async ({ page, project }) => {
    await project.seed("diary.md", DIARY_DOC)
    await project.open(page)
    await openDocument(page, project.id, "diary.md")

    await sendChat(page, "Anything suspicious? E2E-G5-NOMATCH")
    const body = await awaitReply(page, "G5-REPLY-END")

    await expect(body).toContainText("“The quarterly numbers were fabricated by the intern.”")
    await expect(body.locator("a")).toHaveCount(0)
  }
)

test(
  "a quote survives extra whitespace, curly quotes, and dropped commas",
  { tag: ["@G6"] },
  async ({ page, project }) => {
    await project.seed("diary.md", DIARY_DOC)
    await project.open(page)
    await openDocument(page, project.id, "diary.md")

    await sendChat(page, "What does remote work require? E2E-G6-NORM")
    const body = await awaitReply(page, "G6-REPLY-END")

    const quoteLink = body.locator('a[href*="spotlight="]')
    await expect(quoteLink).toHaveCount(1)

    await quoteLink.click()
    const underlined = spotlightSpan(page)
    await expect(underlined).toBeVisible()
    await expect(underlined).toContainText("discipline and trust")
  }
)

test(
  "a quote reflowed across a line break still resolves to a link",
  { tag: ["@G6"] },
  async ({ page, project }) => {
    await project.seed("diary.md", DIARY_DOC)
    await project.open(page)
    await openDocument(page, project.id, "diary.md")

    await sendChat(page, "What does remote work require? E2E-G6-WRAP")
    const body = await awaitReply(page, "G6-WRAP-REPLY-END")

    const quoteLink = body.locator('a[href*="spotlight="]')
    await expect(quoteLink).toHaveCount(1)
  }
)

test(
  "a quotation from a document other than the open one stays plain text",
  { tag: ["@G7"] },
  async ({ page, project }) => {
    await project.seed("diary.md", DIARY_DOC)
    await project.seed("other-notes.md", OTHER_NOTES_DOC)
    await project.open(page)
    await openDocument(page, project.id, "diary.md")

    await sendChat(page, "What did the notes say? E2E-G7-OTHER")
    const body = await awaitReply(page, "G7-REPLY-END")

    await expect(body).toContainText(`“${VENDING_SENTENCE}”`)
    await expect(body.locator("a")).toHaveCount(0)
  }
)
