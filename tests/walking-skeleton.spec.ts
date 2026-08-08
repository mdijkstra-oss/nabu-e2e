import { expect, nabuQuery, test } from "./helpers/fixtures"

// Untagged on purpose: this pins the wiring, not a claim, and the coverage
// report ignores untagged tests.
test("walking skeleton", async ({ page, project }) => {
  await project.open(page)

  await page.locator('textarea[name="chat-message"]').fill("Please echo E2E-SKELETON-MARKER back to me")
  await page.keyboard.press("Enter")
  await expect(page.getByText("SKELETON-REPLY-OK")).toBeVisible({ timeout: 30_000 })

  await expect
    .poll(async () => ((await nabuQuery(page, "select * from files limit 5")) as unknown[]).length, {
      timeout: 30_000,
    })
    .toBeGreaterThan(0)

  const journal = await project.journal()
  const embeddings = journal.filter((e) => e.path === "/embeddings")
  const qualCoder = journal.filter((e) => e.fixture === "walking-skeleton-qual-coder.yaml")
  expect(embeddings.length).toBeGreaterThan(0)
  expect(qualCoder.length).toBeGreaterThan(0)
  expect(Math.min(...embeddings.map((e) => e.seq))).toBeLessThan(
    Math.min(...qualCoder.map((e) => e.seq))
  )
  expect(journal.filter((e) => e.path !== "/embeddings" && e.fixture === null)).toEqual([])
})
