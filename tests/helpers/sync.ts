import { expect, type Locator, type Page, type WebSocketRoute } from "@playwright/test"

export interface CapturedCommand {
  action: string
  path?: string
  newPath?: string
  content?: string
}

/** Record every command the app POSTs for this project, passing them through. */
export const captureCommands = async (
  page: Page,
  projectId: string
): Promise<CapturedCommand[]> => {
  const captured: CapturedCommand[] = []
  await page.route(`**/api/commands/${projectId}`, async (route) => {
    captured.push(route.request().postDataJSON() as CapturedCommand)
    await route.continue()
  })
  return captured
}

export const writesTo = (captured: CapturedCommand[], path: string): CapturedCommand[] =>
  captured.filter((c) => c.action === "WriteFile" && c.path === path)

/** The one editable document editor on the page; read-only stack layers are contenteditable=false. */
export const editor = (page: Page): Locator =>
  page.locator('.ProseMirror[contenteditable="true"]').first()

export const typeIntoEditor = async (page: Page, text: string): Promise<void> => {
  await editor(page).locator("p").first().click()
  await page.keyboard.type(text)
}

// The documents panel is a flyout that opens while the nav rail is hovered;
// its default view lists tag groups, so the filter box is what reaches an
// individual document deterministically.
export const showDocFilter = async (page: Page, filter: string): Promise<void> => {
  // .first(): once the flyout is open its own header also reads "Documents".
  await page.getByText("Documents", { exact: true }).first().hover()
  await page.getByPlaceholder("Filter documents...").fill(filter)
}

export const openDocFromSidebar = async (
  page: Page,
  title: string,
  expectedText: string
): Promise<void> => {
  await showDocFilter(page, title)
  await page.getByText(title, { exact: true }).first().click()
  await expect(editor(page)).toContainText(expectedText)
}

// Topic tagging and embedding companions keep writing for a moment after the
// boot overlay clears; command counting must start after that tail flushes.
export const drainBootWrites = (page: Page): Promise<void> => page.waitForTimeout(1500)

// The reconnect backoff is jittered (Math.random() * ceiling); pinning random
// to ~1 makes each gap the deterministic ceiling so page.clock can measure it.
export const pinBackoffJitter = (page: Page): Promise<void> =>
  page.evaluate(() => {
    Math.random = () => 0.9999
  })

export interface WsControl {
  /** Drop the current socket; the app reconnects and receives a fresh full sync. */
  sever: () => void
}

// Storage only streams files on connect (no mid-session broadcast), so the way
// to make a freshly seeded file "arrive from the server" is a forced resync.
// Must be called before the page navigates to the project.
export const interceptWs = async (page: Page): Promise<WsControl> => {
  let current: WebSocketRoute | null = null
  await page.routeWebSocket(/\/api\/ws\//, (ws) => {
    current = ws
    const server = ws.connectToServer()
    ws.onMessage((m) => server.send(m))
    server.onMessage((m) => ws.send(m))
  })
  return { sever: () => current?.close() }
}
