import type { WebSocketRoute } from "@playwright/test"
import { test, expect } from "../helpers/fixtures"
import { showDocFilter } from "../helpers/sync"

interface Frame {
  action: string
  path?: string
  fileCount?: number
}

const asText = (m: string | Buffer): string => (typeof m === "string" ? m : m.toString())

test("a project loads as a SyncMeta count followed by WriteFile commands sorted by name", { tag: ["@Y5"] }, async ({ page, project }) => {
  // Names chosen to sort before and after the seeded corpus.
  await project.seed("0-first.md", "# First\n\nSorts before everything.\n")
  await project.seed("zz-last.md", "# Last\n\nSorts after everything.\n")

  const frames: string[] = []
  await page.routeWebSocket(/\/api\/ws\//, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((m) => server.send(m))
    server.onMessage((m) => {
      frames.push(asText(m))
      ws.send(m)
    })
  })

  await project.open(page)

  const commands: Frame[] = frames.map((f) => JSON.parse(f) as Frame)
  expect(commands[0].action).toBe("SyncMeta")
  const fileCount = commands[0].fileCount!
  expect(fileCount).toBeGreaterThanOrEqual(7)

  // Frames after the initial burst are echoes of this session's own writes.
  const initial = commands.slice(1, 1 + fileCount)
  expect(initial).toHaveLength(fileCount)
  expect(initial.every((c) => c.action === "WriteFile")).toBe(true)

  const paths = initial.map((c) => c.path!)
  expect([...paths].sort()).toEqual(paths)
  expect(paths[0]).toBe("0-first.md")
  expect(paths).toContain("zz-last.md")
  expect(paths).toContain("settings.hidden.md")
  expect(paths).toContain("preferences.md")

  // The store filled from those commands: the app is usable and lists them.
  await showDocFilter(page, "0-First")
  await expect(page.getByText("0-First", { exact: true }).first()).toBeVisible()
  await showDocFilter(page, "Zz-Last")
  await expect(page.getByText("Zz-Last", { exact: true }).first()).toBeVisible()
})

test("boot holds the loading gate until settings and preferences exist", { tag: ["@Y5"] }, async ({ page, project }) => {
  const required = ["settings.hidden.md", "preferences.md"]
  const held: string[] = []
  let gate: WebSocketRoute | null = null

  // Hold the two required files back and shrink SyncMeta accordingly, so the
  // file-count gate opens and boot is left waiting on the required-files gate.
  await page.routeWebSocket(/\/api\/ws\//, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((m) => server.send(m))
    server.onMessage((m) => {
      const text = asText(m)
      const cmd = JSON.parse(text) as Frame
      if (cmd.action === "SyncMeta") {
        ws.send(JSON.stringify({ ...cmd, fileCount: cmd.fileCount! - required.length }))
        return
      }
      if (cmd.action === "WriteFile" && required.includes(cmd.path!)) {
        held.push(text)
        gate = ws
        return
      }
      ws.send(text)
    })
  })

  const opened = project.open(page)

  await expect.poll(() => held.length, { timeout: 30_000 }).toBe(required.length)
  await page.waitForTimeout(3_000)
  await expect(page.getByText("Getting everything ready for you")).toBeVisible()

  for (const frame of held) gate!.send(frame)
  await opened
  await expect(page.getByText("Getting everything ready for you")).toBeHidden()
})
