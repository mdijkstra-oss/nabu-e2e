import { type Page } from "@playwright/test"

export const sendChat = async (page: Page, text: string): Promise<void> => {
  const box = page.locator('textarea[name="chat-message"]')
  await box.fill(text)
  await box.press("Enter")
  // A boot-time re-render can detach the textarea and swallow the Enter; the
  // box only empties once the app accepted the message, so keep pressing.
  // The accepted case must add no delay: callers assert against frozen-clock
  // states that pre-install real timers can invalidate while we wait.
  for (let i = 0; i < 30; i++) {
    if ((await box.inputValue()) === "") return
    await page.waitForTimeout(500)
    if ((await box.inputValue()) === "") return
    await box.press("Enter")
  }
  throw new Error(`chat message was never accepted: ${text}`)
}
