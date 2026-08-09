import { expect, type Locator, type Page } from "@playwright/test"
import { waitForBoot } from "./fixtures"

export const CALLOUT_ID = "callout-1abcd234"
export const CALLOUT_TITLE = "Remote Autonomy"
export const CALLOUT_COLOR = "tomato"

const calloutJson = JSON.stringify({
  id: CALLOUT_ID,
  type: "codebook-code",
  title: CALLOUT_TITLE,
  content: "Mentions of setting one's own hours while remote.",
  color: CALLOUT_COLOR,
  collapsed: false,
})

const fence = "```"

export const CODEBOOK_DOC = [
  "# Codebook",
  "",
  "Working codes for the remote work study.",
  "",
  `${fence}json-callout`,
  calloutJson,
  fence,
  "",
].join("\n")

export const TAG_ID = "tag-1a2b3c4d"
export const TAG_LABEL = "morale"
export const TAG_COLOR = "jade"

export const SETTINGS_DOC = [
  "# Settings",
  "",
  `${fence}json-settings`,
  JSON.stringify({ tags: [{ id: TAG_ID, label: TAG_LABEL, color: TAG_COLOR, icon: "anchor" }] }),
  fence,
  "",
].join("\n")

export const STANDUP_SENTENCE =
  "The afternoon standup felt shorter than usual because everyone had already written their updates in the shared channel."

export const TRUST_SENTENCE =
  'Working from home, she said, requires "discipline and trust" every single day.'

export const REVIEW_SENTENCE = "Deep focus in the morning made the code review painless."

const filler = Array.from(
  { length: 28 },
  (_, i) => `Log entry ${i + 1}: routine notes, nothing remarkable happened before lunch.`
).join("\n\n")

export const DIARY_DOC = [
  "# Remote diary",
  "",
  filler,
  "",
  STANDUP_SENTENCE,
  "",
  TRUST_SENTENCE,
  "",
  REVIEW_SENTENCE,
  "",
].join("\n")

export const VENDING_SENTENCE = "The vending machine only accepted exact change on rainy days."

export const OTHER_NOTES_DOC = ["# Other notes", "", VENDING_SENTENCE, ""].join("\n")

export { sendChat } from "./chat"

/** Wait for the scripted reply to stream in, and return its message body. */
export const awaitReply = async (page: Page, sentinel: string): Promise<Locator> => {
  await expect(page.getByText(sentinel)).toBeVisible({ timeout: 30_000 })
  return page.locator("div.prose").filter({ hasText: sentinel }).last()
}

/** Full-page navigation to a document; the fileId route param is the filename. */
export const openDocument = async (
  page: Page,
  projectId: string,
  fileName: string
): Promise<void> => {
  await page.goto(`/project/${projectId}/file/${encodeURIComponent(fileName)}`)
  await waitForBoot(page)
}

export const inViewport = async (page: Page, locator: Locator): Promise<boolean> => {
  const box = await locator.boundingBox()
  if (!box) return false
  const height = page.viewportSize()?.height ?? 720
  return box.y >= 0 && box.y + box.height <= height
}
