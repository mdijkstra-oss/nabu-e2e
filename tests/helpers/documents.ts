import { expect, type Page } from "@playwright/test"
import { waitForBoot, type JournalEntry, type ProjectHandle } from "./fixtures"

/** Merge extra flags into the app's debug options before the page boots. */
export const setDebugOptions = async (page: Page, opts: Record<string, unknown>): Promise<void> => {
  await page.addInitScript((extra) => {
    const key = "nabu-debug-options"
    let stored: Record<string, unknown> = {}
    try {
      stored = JSON.parse(localStorage.getItem(key) ?? "{}")
    } catch {}
    localStorage.setItem(key, JSON.stringify({ ...stored, ...extra }))
  }, opts)
}

/** Navigate straight to one document and wait for the boot gate. */
export const openDocument = async (
  page: Page,
  project: ProjectHandle,
  filePath: string,
  debugOptions: Record<string, unknown> = {}
): Promise<void> => {
  await setDebugOptions(page, { skipCache: true, ...debugOptions })
  await page.goto(`/project/${project.id}/file/${encodeURIComponent(filePath)}`)
  await waitForBoot(page)
}

export { sendChat } from "./chat"

export const waitForReply = (page: Page, marker: string): Promise<void> =>
  expect(page.getByText(marker)).toBeVisible({ timeout: 45_000 })

/** All function_call_output payloads the agent sent back to the fake, as one string. */
export const toolOutputs = (entries: JournalEntry[]): string => {
  const outputs: string[] = []
  for (const entry of entries) {
    if (entry.path !== "/qual-coder") continue
    const input = (entry.body as { input?: unknown[] })?.input ?? []
    for (const item of input) {
      const typed = item as { type?: string; output?: string }
      if (typed.type === "function_call_output" && typeof typed.output === "string") {
        outputs.push(typed.output)
      }
    }
  }
  return outputs.join("\n")
}

/** The fenced block of one language from raw markdown, fences excluded. */
export const extractBlock = (content: string, language: string): string | null => {
  const re = new RegExp("```" + language + "\\n([\\s\\S]*?)\\n```")
  const m = content.match(re)
  return m ? m[1] : null
}

/** The "Database schema (DuckDB)" system message of a journaled /qual-coder request. */
export const schemaMessageOf = (entry: JournalEntry): string | null => {
  const input = (entry.body as { input?: unknown[] })?.input ?? []
  for (const item of input) {
    const typed = item as { role?: string; content?: unknown }
    if (
      typed.role === "system" &&
      typeof typed.content === "string" &&
      typed.content.includes("Database schema (DuckDB)")
    ) {
      return typed.content
    }
  }
  return null
}

const jsonAnnotationsBlock = (
  annotations: Record<string, unknown>[]
): string => "```json-annotations\n" + JSON.stringify({ annotations }, null, "\t") + "\n```"

export const seedAnnotationsDoc = (prose: string, annotations: Record<string, unknown>[]): string =>
  `${prose}\n\n${jsonAnnotationsBlock(annotations)}\n`
