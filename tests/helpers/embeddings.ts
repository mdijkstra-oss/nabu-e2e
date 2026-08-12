import type { Page } from "@playwright/test"
import { readVolumeFile } from "../../harness/volume"
import type { JournalEntry } from "./fixtures"

export interface EmbeddingsBody {
  input: string[]
  model: string
  dimensions: number
}

export const embeddingsEntries = (journal: JournalEntry[], sinceSeq = 0): JournalEntry[] =>
  journal.filter((e) => e.path === "/embeddings" && e.seq > sinceSeq)

export const embeddingsBody = (entry: JournalEntry): EmbeddingsBody => entry.body as EmbeddingsBody

export const inputsOf = (entries: JournalEntry[]): string[] =>
  entries.flatMap((e) => embeddingsBody(e).input)

export const maxSeq = (journal: JournalEntry[]): number =>
  journal.reduce((m, e) => Math.max(m, e.seq), 0)

export interface CompanionEntry {
  hash: string
  text: string
  embedding: number[]
  chunkStart: number
  chunkEnd: number
}

export const companionName = (sourceFile: string): string =>
  sourceFile.replace(/\.md$/, ".embeddings.hidden.md")

export const parseCompanionMarkdown = (markdown: string): CompanionEntry[] =>
  [...markdown.matchAll(/```json-embeddings\n([\s\S]*?)\n```/g)].map(
    (m) => JSON.parse(m[1]) as CompanionEntry
  )

export const readCompanion = async (
  projectId: string,
  sourceFile: string
): Promise<string | null> => {
  try {
    return await readVolumeFile(`${projectId}/${companionName(sourceFile)}`)
  } catch {
    return null
  }
}

/**
 * Drive the in-page debounces (5s embedding sync, 500ms persist) forward until
 * the probe yields a value. The clock jump only fires page timers; the fetches
 * they trigger run on the real network, hence the short real-time grace.
 */
// Advancing the clock releases the debounce; the request it releases still needs real time
// to go out and come back, and a boot that embeds several chunks needs more of it than one
// that embeds two — especially with the other workers busy.
export const advanceUntil = async <T>(
  page: Page,
  probe: () => Promise<T | undefined | false | null>,
  { stepMs = 6000, tries = 30, settleMs = 1000 }: { stepMs?: number; tries?: number; settleMs?: number } = {}
): Promise<T> => {
  for (let i = 0; i < tries; i++) {
    const value = await probe()
    if (value) return value
    await page.clock.fastForward(stepMs)
    await new Promise((r) => setTimeout(r, settleMs))
  }
  throw new Error(`condition not reached after ${tries} clock advances of ${stepMs}ms`)
}

const filler = (token: string, i: number): string =>
  `The ${token} log entry number ${String(i).padStart(2, "0")} records steady rhythms and small changes in the remote studio today.`

/**
 * Appends ~108-char sentences until the prose reaches minLength. Every boundary falls
 * between two of them, so a same-length edit inside one sentence leaves the units around
 * it byte-identical.
 */
export const padProse = (token: string, prefix: string, minLength: number, startIndex = 0): string => {
  let out = prefix
  let i = startIndex
  while (out.length < minLength) out = out.length === 0 ? filler(token, i++) : `${out} ${filler(token, i++)}`
  return out
}
