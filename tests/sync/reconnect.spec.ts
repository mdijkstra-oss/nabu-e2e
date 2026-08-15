import { test, expect } from "../helpers/fixtures"
import { drainBootWrites, editor, interceptWs, pinBackoffJitter, typeIntoEditor } from "../helpers/sync"

declare global {
  interface Window {
    __wsAttempts?: number[]
  }
}

// With jitter pinned to ~1 each backoff delay is its ceiling: 1s, 2s, 4s, 8s,
// 16s, then capped at 30s (the uncapped sixth ceiling would be 32s). Attempt
// times are recorded in fake-clock milliseconds inside the page, so the gaps
// can be measured instead of stepped around.
const CEILINGS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]

test("a dropped websocket reconnects with capped exponential backoff while editing continues", { tag: ["@stack"] }, async ({ page, project }) => {
  const ws = await interceptWs(page)

  let framesReceived = 0
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/api/ws/")) return
    socket.on("framereceived", () => {
      framesReceived++
    })
  })

  await project.open(page)
  await drainBootWrites(page)

  await typeIntoEditor(page, " E2E-Y4-BEFORE-DROP")
  await expect(editor(page)).toContainText("E2E-Y4-BEFORE-DROP")

  await pinBackoffJitter(page)
  // Date.now() is faked below, so these timestamps are fake-clock readings.
  await page.evaluate(() => {
    window.__wsAttempts = []
    const Original = window.WebSocket
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        window.__wsAttempts!.push(Date.now())
        super(url, protocols)
      }
    } as typeof WebSocket
  })
  await page.clock.install()
  // Reconnect attempts must fail at the network layer (an `open` would reset
  // the backoff), so interception ends and the network goes away before the
  // live socket is severed.
  await page.context().setOffline(true)
  await page.unrouteAll()
  ws.sever()
  await page.waitForTimeout(200)

  const attempts = (): Promise<number[]> => page.evaluate(() => window.__wsAttempts ?? [])

  // Advance in slices, letting each failed handshake deliver its close event
  // (real time) so the next backoff timer exists before fake time moves on.
  const totalFake = CEILINGS.reduce((a, b) => a + b, 0) + 8_000
  for (let elapsed = 0; elapsed < totalFake; elapsed += 1_000) {
    await page.clock.runFor(1_000)
    await page.waitForTimeout(30)
  }

  const offlineAttempts = await attempts()
  expect(offlineAttempts.length).toBe(CEILINGS.length)
  const gaps = offlineAttempts.slice(1).map((t, i) => t - offlineAttempts[i])
  gaps.forEach((gap, i) => {
    const ceiling = CEILINGS[i + 1]
    expect(gap, `gap ${i + 1} vs ceiling ${ceiling}`).toBeGreaterThanOrEqual(ceiling * 0.8)
    // The slack covers slice quantization; 30_000 + slack still rejects the
    // uncapped 32_000.
    expect(gap, `gap ${i + 1} vs ceiling ${ceiling}`).toBeLessThanOrEqual(ceiling + 1_600)
  })

  // Local editing kept working the whole time the connection was down.
  await typeIntoEditor(page, " E2E-Y4-WHILE-DOWN")
  await expect(editor(page)).toContainText("E2E-Y4-WHILE-DOWN")

  // Once the network returns, the next attempt connects and resyncs.
  framesReceived = 0
  await page.context().setOffline(false)
  for (let elapsed = 0; elapsed < 31_000 && framesReceived === 0; elapsed += 1_000) {
    await page.clock.runFor(1_000)
    await page.waitForTimeout(30)
  }
  expect(framesReceived).toBeGreaterThan(0)
})
