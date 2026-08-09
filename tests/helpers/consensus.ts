import { expect, type Page } from "@playwright/test"
import { nabuQuery, type JournalEntry } from "./fixtures"
import { readVolumeFile } from "../../harness/volume"

export const FILE_HYDE = "/file-hyde"
export const SEMANTIC_FILTER = "/semantic-filter"
export const VOTER_ONE = "/deep-analysis-filter.voter-one"
export const VOTER_TWO = "/deep-analysis-filter.voter-two"
export const ADJUDICATE = "/deep-analysis-adjudicate"

const partText = (part: unknown): string =>
  part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
    ? ((part as { text: string }).text)
    : ""

const itemText = (item: unknown): string => {
  if (typeof item === "string") return item
  if (item === null || typeof item !== "object") return ""
  const rec = item as Record<string, unknown>
  const pieces: string[] = []
  if (typeof rec.content === "string") pieces.push(rec.content)
  else if (Array.isArray(rec.content)) pieces.push(...rec.content.map(partText))
  if (typeof rec.arguments === "string") pieces.push(rec.arguments)
  if (typeof rec.output === "string") pieces.push(rec.output)
  return pieces.filter(Boolean).join("\n")
}

// Mirrors the fake's match.js extractText so assertions see the same request
// text that fixture matching saw.
export const requestText = (entry: JournalEntry): string => {
  const input = (entry.body as { input?: unknown } | null)?.input
  if (typeof input === "string") return input
  if (!Array.isArray(input)) return ""
  return input.map(itemText).filter(Boolean).join("\n")
}

export const countMatches = (text: string, re: RegExp): number => (text.match(re) ?? []).length

export const sendChat = async (page: Page, message: string): Promise<void> => {
  const box = page.locator('textarea[name="chat-message"]')
  await box.fill(message)
  await page.keyboard.press("Enter")
}

// The find step reads chunk hashes and languages from the in-browser files
// table; a run fired before the embeddings sync lands finds no candidates.
export const waitForCorpus = async (page: Page, file: string): Promise<void> => {
  await expect
    .poll(
      async () =>
        (
          (await nabuQuery(
            page,
            `select distinct hash from files where file = '${file}' and language is not null`
          )) as unknown[]
        ).length,
      { timeout: 60_000 }
    )
    .toBeGreaterThan(0)
}

export const calloutBlock = (id: string, title: string, content: string): string =>
  "```json-callout\n" +
  JSON.stringify({ id, type: "codebook-code", title, content, color: "blue", collapsed: false }) +
  "\n```"

export interface DocAnnotation {
  id?: string
  text: string
  reason: string
  code?: string
  color?: string
  vote?: { find: { found: number; missed: number }; review?: string }
}

const ANNOTATIONS_BLOCK_RE = /```json-annotations\s*\n([\s\S]*?)```/

export const readAnnotations = async (
  projectId: string,
  file: string
): Promise<DocAnnotation[] | null> => {
  let raw: string
  try {
    raw = await readVolumeFile(`${projectId}/${file}`)
  } catch {
    return null
  }
  const match = ANNOTATIONS_BLOCK_RE.exec(raw)
  if (!match) return null
  try {
    return (JSON.parse(match[1]) as { annotations: DocAnnotation[] }).annotations
  } catch {
    return null
  }
}

export const pollAnnotations = async (
  projectId: string,
  file: string,
  min: number
): Promise<DocAnnotation[]> => {
  let annotations: DocAnnotation[] = []
  await expect
    .poll(
      async () => {
        annotations = (await readAnnotations(projectId, file)) ?? []
        return annotations.length
      },
      { timeout: 45_000 }
    )
    .toBeGreaterThanOrEqual(min)
  return annotations
}

export const expectNoUnmatchedLlmCalls = (journal: JournalEntry[]): void => {
  expect(journal.filter((e) => e.path !== "/embeddings" && e.fixture === null)).toEqual([])
}
