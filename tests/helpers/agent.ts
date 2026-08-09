import { expect, type Page } from "@playwright/test"
import type { JournalEntry, ProjectHandle } from "./fixtures"

export const sendChat = async (page: Page, text: string): Promise<void> => {
  const box = page.locator('textarea[name="chat-message"]')
  await box.click()
  await box.fill(text)
  await page.keyboard.press("Enter")
}

/** The single icon button in the chat input row (send/cancel/skip, mode-dependent). */
export const chatButton = (page: Page) =>
  page.locator('div.rounded-2xl:has(textarea[name="chat-message"]) button')

const isMapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const partText = (part: unknown): string =>
  isMapping(part) && typeof part.text === "string" ? part.text : ""

// Mirrors the fake's match.js so `contains` reasoning and test assertions see
// the same text.
const itemText = (item: unknown): string => {
  if (typeof item === "string") return item
  if (!isMapping(item)) return ""
  const pieces: string[] = []
  if (typeof item.content === "string") pieces.push(item.content)
  else if (Array.isArray(item.content)) pieces.push(...item.content.map(partText))
  if (typeof item.arguments === "string") pieces.push(item.arguments)
  if (typeof item.output === "string") pieces.push(item.output)
  return pieces.filter(Boolean).join("\n")
}

const inputItems = (entry: JournalEntry): unknown[] => {
  const body = entry.body
  if (!isMapping(body)) return []
  return Array.isArray(body.input) ? body.input : []
}

export const entryText = (entry: JournalEntry): string =>
  inputItems(entry).map(itemText).filter(Boolean).join("\n")

export const toolNames = (entry: JournalEntry): string[] => {
  const body = entry.body
  if (!isMapping(body) || !Array.isArray(body.tools)) return []
  return body.tools
    .map((t: unknown) => (isMapping(t) && typeof t.name === "string" ? t.name : ""))
    .filter(Boolean)
}

export interface ToolOutput {
  name: string
  callId: string
  output: string
}

/** function_call_output items of a request, joined with their tool names via call_id. */
export const toolOutputs = (entry: JournalEntry): ToolOutput[] => {
  const items = inputItems(entry)
  const nameById: Record<string, string> = {}
  for (const it of items) {
    if (isMapping(it) && it.type === "function_call" && typeof it.call_id === "string") {
      nameById[it.call_id] = typeof it.name === "string" ? it.name : ""
    }
  }
  return items
    .filter((it): it is Record<string, unknown> => isMapping(it) && it.type === "function_call_output")
    .map((it) => ({
      name: nameById[String(it.call_id)] ?? "",
      callId: String(it.call_id),
      output: String(it.output ?? ""),
    }))
}

/** This project's agent-loop requests (any /qual-coder* endpoint) whose transcript carries the marker. */
export const agentEntries = async (
  project: ProjectHandle,
  marker: string
): Promise<JournalEntry[]> => {
  const journal = await project.journal()
  return journal.filter(
    (e) => e.path.startsWith("/qual-coder") && entryText(e).includes(marker)
  )
}

export const waitForAgentEntries = async (
  project: ProjectHandle,
  marker: string,
  count: number,
  timeout = 30_000
): Promise<JournalEntry[]> => {
  await expect
    .poll(async () => (await agentEntries(project, marker)).length, { timeout })
    .toBeGreaterThanOrEqual(count)
  return agentEntries(project, marker)
}

export const lastEntry = (entries: JournalEntry[]): JournalEntry => {
  if (entries.length === 0) throw new Error("no journal entries to take the last of")
  return entries[entries.length - 1]
}
