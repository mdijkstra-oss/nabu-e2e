import type { Page } from "@playwright/test"
import { expect } from "@playwright/test"
import { nabuQuery, waitForBoot, type ProjectHandle } from "./fixtures"

export interface SearchEntrySeed {
  id: string
  title: string
  description: string
  highlight: string
  sql: string
  saved?: boolean
}

/** Settings file with pre-planted search entries; the app patches its own keys
 * (corpusDescriptions, …) into the same block later, so seeded searches survive. */
export const settingsWithSearches = (entries: SearchEntrySeed[]): string => {
  const searches = entries.map((e) => ({
    id: e.id,
    title: e.title,
    description: e.description,
    highlight: e.highlight,
    saved: e.saved ?? true,
    createdAt: Date.now(),
    sql: e.sql,
  }))
  return `# Settings\n\n\`\`\`json-settings\n${JSON.stringify({ tags: [], searches, corpusDescriptions: [] }, null, "\t")}\n\`\`\`\n`
}

/** Merge extra debug options into localStorage before the app boots.
 * Register before project.open so open's own skipCache merge lands on top. */
export const presetDebugOptions = async (
  page: Page,
  options: Record<string, boolean>
): Promise<void> => {
  await page.addInitScript((opts) => {
    const key = "nabu-debug-options"
    let stored: Record<string, unknown> = {}
    try {
      stored = JSON.parse(localStorage.getItem(key) ?? "{}")
    } catch {}
    localStorage.setItem(key, JSON.stringify({ ...stored, ...opts }))
  }, options)
}

/** Wait until every given file has embedded chunks (with language) in the
 * in-browser files table — semantic resolution errors out before that. */
export const waitForChunks = async (page: Page, files: string[]): Promise<void> => {
  for (const file of files) {
    await expect
      .poll(
        async () => {
          const rows = (await nabuQuery(
            page,
            `SELECT count(*)::int AS n FROM files WHERE file = '${file.replace(/'/g, "''")}' AND language IS NOT NULL`
          )) as { n: number }[]
          return rows[0]?.n ?? 0
        },
        { timeout: 60_000, message: `chunks for ${file} in files table` }
      )
      .toBeGreaterThan(0)
  }
}

/** Full-page navigation to a seeded search entry's result page. */
export const gotoSearch = async (
  page: Page,
  project: ProjectHandle,
  searchId: string
): Promise<void> => {
  await page.goto(`/project/${project.id}/search/${searchId}`)
  await waitForBoot(page)
}

/** One rendered hit inside the result cards. */
export const hitLocator = (page: Page) => page.locator('div[class*="group/hit"]')

export const stringifyBody = (body: unknown): string => JSON.stringify(body)

/** Journal entries for one endpoint, oldest first. */
export const entriesFor = (
  journal: { seq: number; path: string; body: unknown; fixture: string | null }[],
  path: string
) => journal.filter((e) => e.path === path).sort((a, b) => a.seq - b.seq)

export const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1
