import { test as base, expect, type Page } from "@playwright/test"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { e2eRoot } from "../../harness/env"
import { readState } from "../../harness/state"

export interface JournalEntry {
  seq: number
  path: string
  projectId: string | null
  body: unknown
  fixture: string | null
}

export interface ProjectHandle {
  id: string
  /** Write one file into this project through the storage API. */
  seed: (filePath: string, content: string) => Promise<void>
  /** Navigate to the project and wait for the loading gate to open. */
  open: (page: Page, opts?: { skipCache?: boolean }) => Promise<void>
  /** Journal entries carrying this project's id — other projects' traffic is unreachable. */
  journal: () => Promise<JournalEntry[]>
}

export const BASE_PROJECT_DIR = path.join(e2eRoot, "base-project")

const apiBase = (): string => process.env.NABU_E2E_BASE_URL || readState().baseURL

export const bootedTier = (): string => readState().tier

const postCommand = async (projectId: string, command: Record<string, unknown>): Promise<void> => {
  const res = await fetch(`${apiBase()}/api/commands/${projectId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  })
  if (!res.ok) {
    throw new Error(`POST /api/commands/${projectId} -> ${res.status}: ${await res.text()}`)
  }
}

export const seedBaseCorpus = async (projectId: string): Promise<void> => {
  const files = fs.readdirSync(BASE_PROJECT_DIR).filter((f) => !f.startsWith(".")).sort()
  for (const file of files) {
    const content = fs.readFileSync(path.join(BASE_PROJECT_DIR, file), "utf8")
    await postCommand(projectId, { action: "WriteFile", path: file, content })
  }
}

export const waitForBoot = async (page: Page): Promise<void> => {
  // The chat textarea renders behind the boot overlay, so visibility alone
  // does not mean the loading gate opened; the overlay leaving does.
  await expect(page.locator('textarea[name="chat-message"]')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText("Getting everything ready for you")).toBeHidden({ timeout: 120_000 })
}

export const openProject = async (
  page: Page,
  projectId: string,
  opts: { skipCache?: boolean } = {}
): Promise<void> => {
  const skipCache = opts.skipCache ?? true
  // The LLM response cache would let a repeated call pass without the fake
  // ever seeing it; S7 alone runs with the cache on.
  await page.addInitScript((skip) => {
    const key = "nabu-debug-options"
    let stored: Record<string, unknown> = {}
    try {
      stored = JSON.parse(localStorage.getItem(key) ?? "{}")
    } catch {}
    localStorage.setItem(key, JSON.stringify({ ...stored, skipCache: skip }))
  }, skipCache)
  await page.goto(`/project/${projectId}`)
  await waitForBoot(page)
}

export const fetchJournal = async (projectId?: string): Promise<JournalEntry[]> => {
  const url = projectId
    ? `${apiBase()}/llm/_e2e/journal?project=${projectId}`
    : `${apiBase()}/llm/_e2e/journal`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`journal fetch -> ${res.status}: ${await res.text()}`)
  return (await res.json()) as JournalEntry[]
}

export const nabuQuery = async (page: Page, sql: string): Promise<unknown[]> => {
  // The hook attaches once the DuckDB singleton is ready; poll rather than race it.
  await page.waitForFunction(() => !!(window as unknown as { __nabuTest?: unknown }).__nabuTest, undefined, {
    timeout: 30_000,
  })
  return page.evaluate(async (q) => {
    const hook = (window as unknown as { __nabuTest?: { query: (s: string) => Promise<unknown[]> } })
      .__nabuTest
    if (!hook) throw new Error("window.__nabuTest is not attached")
    return hook.query(q)
  }, sql)
}

export interface E2eFixtures {
  /** A fresh project seeded with the base corpus, before any page navigates to it. */
  project: ProjectHandle
}

export const test = base.extend<E2eFixtures>({
  project: async ({}, use) => {
    const id = crypto.randomUUID()
    await seedBaseCorpus(id)
    const handle: ProjectHandle = {
      id,
      seed: (filePath, content) => postCommand(id, { action: "WriteFile", path: filePath, content }),
      open: (page, opts) => openProject(page, id, opts),
      journal: () => fetchJournal(id),
    }
    await use(handle)
  },
})

export { expect }
