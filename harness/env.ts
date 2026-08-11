import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type Tier = "stubbed" | "stack" | "real"
export type Mode = "override" | "real"

export const e2eRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const nabuRoot = path.resolve(e2eRoot, "..")
export const selfHostedDir = path.join(nabuRoot, "nabu-self-hosted")

export const COMPOSE_PROJECT = "nabu-e2e"
export const STATE_FILE = path.join(e2eRoot, ".e2e-state.json")

// Storage bind-mounts this, so it must exist before the stack boots and be
// writable by uid 65532. Outside the checkout: the stack writes here, and a
// path under e2eRoot would put every run's projects under version control.
// Fixed rather than mktemp because setup, teardown and the test workers are
// separate processes that all have to name the same directory.
export const PROJECT_DIR = path.join(os.tmpdir(), "nabu-e2e-projects")

export const resetProjectDir = (): void => {
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true })
  fs.mkdirSync(PROJECT_DIR, { recursive: true })
  // 0777 because the container user is not the user that created it, and
  // on Linux nothing else would make it writable to uid 65532.
  fs.chmodSync(PROJECT_DIR, 0o777)
}

export const removeProjectDir = (): void => {
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true })
}

export const resolveTier = (): Tier => {
  const raw = process.env.NABU_E2E_TIER ?? "stubbed"
  if (raw !== "stubbed" && raw !== "stack" && raw !== "real") {
    throw new Error(`NABU_E2E_TIER=${raw}: expected stubbed, stack, or real`)
  }
  return raw
}

export const modeForTier = (tier: Tier): Mode => (tier === "real" ? "real" : "override")

export const resolvePort = (): string => process.env.NABU_PORT || "8099"

export const baseUrl = (): string => `http://localhost:${resolvePort()}`

// Absolute paths because relative paths in a merged compose file resolve
// against the first file's directory, and env-interpolated mounts must not
// land inside nabu-self-hosted.
export const composeEnv = (mode: Mode): Record<string, string> => {
  const env: Record<string, string> = {
    NABU_PORT: resolvePort(),
    PROJECT_DIR,
    NABU_FRONTEND_REPO: path.join(nabuRoot, "nabu-frontend"),
    NABU_STORAGE_REPO: path.join(nabuRoot, "nabu-storage"),
  }
  if (mode === "override") {
    env.NABU_E2E_FAKE_CONTEXT = path.join(e2eRoot, "fake-model-server")
    env.NABU_E2E_FIXTURES = path.join(e2eRoot, "fixtures")
  } else {
    env.NABU_EMBEDDINGS_REPO = process.env.NABU_EMBEDDINGS_REPO || path.join(nabuRoot, "nabu-embeddings")
    env.NABU_PROMPTS_REPO = process.env.NABU_PROMPTS_REPO || path.join(nabuRoot, "nabu-prompts")
    env.CHANCERY_REPO = process.env.CHANCERY_REPO || path.join(nabuRoot, "chancery")
    env.DRAGOMAN_REPO = process.env.DRAGOMAN_REPO || path.join(nabuRoot, "dragoman")
  }
  return env
}

export const requiredSiblings = (mode: Mode): string[] => {
  const env = composeEnv(mode)
  if (mode === "override") {
    return [env.NABU_FRONTEND_REPO, env.NABU_STORAGE_REPO, env.NABU_E2E_FAKE_CONTEXT]
  }
  return [
    env.NABU_FRONTEND_REPO,
    env.NABU_STORAGE_REPO,
    env.NABU_EMBEDDINGS_REPO,
    env.NABU_PROMPTS_REPO,
    env.CHANCERY_REPO,
    env.DRAGOMAN_REPO,
  ]
}
