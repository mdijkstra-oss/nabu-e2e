import { test } from "@playwright/test"
import { bootedTier, expect, waitForBoot } from "./helpers/fixtures"

// Pins spec.md's "What must not change": the unmodified compose file with
// real providers serves the app and answers a chat message. @smoke puts it
// in the real project without claiming a checkbox.
test("unmodified stack serves and answers a chat message @smoke", async ({ page }) => {
  // Selecting --project real does not select the harness mode; a real-tier
  // test against an override stack would "verify" the wrong stack, so this
  // fails loud instead of skipping.
  expect(bootedTier(), "stack booted in override mode; run with NABU_E2E_TIER=real").toBe("real")

  await page.goto("/")
  await page.waitForURL(/\/project\//, { timeout: 30_000 })
  await waitForBoot(page)

  await page.locator('textarea[name="chat-message"]').fill("Reply with the single word: pong")
  await page.keyboard.press("Enter")
  await expect(page.getByText(/pong/i).last()).toBeVisible({ timeout: 120_000 })
})
