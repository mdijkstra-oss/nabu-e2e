import fs from "node:fs"
import {
  baseUrl,
  modeForTier,
  requiredSiblings,
  resetProjectDir,
  resolveTier,
  type Mode,
} from "./env"
import { checkComposeVersion, compose, teardownCommand } from "./compose"
import { writeState } from "./state"

const READY_TIMEOUT_MS = 300_000
const BUILD_TIMEOUT_MS = 1_800_000
const POLL_INTERVAL_MS = 1_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const fetchOk = async (url: string): Promise<Response | null> => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    return res.ok ? res : null
  } catch {
    return null
  }
}

// Three conditions, in order: port up, app shell served, storage answering
// through its own route. Storage starts empty; each test creates the project
// it needs.
const waitForReady = async (base: string): Promise<void> => {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let stage = "GET /health"
  while (Date.now() < deadline) {
    if (await fetchOk(`${base}/health`)) {
      stage = "GET /"
      if (await fetchOk(`${base}/`)) {
        stage = "GET /api/queries/projects"
        if (await fetchOk(`${base}/api/queries/projects`)) return
      }
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(`stack not ready after ${READY_TIMEOUT_MS / 1000}s; last unmet condition: ${stage}`)
}

const dumpLogs = async (mode: Mode): Promise<void> => {
  try {
    const { stdout } = await compose(mode, ["logs", "--no-color", "--tail", "150"])
    console.error("--- compose logs ---\n" + stdout)
  } catch (e) {
    console.error(`could not read compose logs: ${(e as Error).message}`)
  }
}

export default async function globalSetup(): Promise<void> {
  const tier = resolveTier()
  const mode = modeForTier(tier)

  // Reuse an already-booted stack: the edit-run loop during development
  // re-invokes none of the docker lifecycle, only the readiness check.
  if (process.env.NABU_E2E_REUSE) {
    await waitForReady(baseUrl())
    writeState({ baseURL: baseUrl(), tier, mode })
    process.env.NABU_E2E_BASE_URL = baseUrl()
    return
  }

  await checkComposeVersion()

  const missing = requiredSiblings(mode).filter((p) => !fs.existsSync(p))
  if (missing.length > 0) {
    throw new Error(`missing checkouts the ${mode} mode builds from:\n  ${missing.join("\n  ")}`)
  }
  if (mode === "real" && !process.env.OPENAI_API_KEY) {
    throw new Error("real mode needs OPENAI_API_KEY: the openai preset runs every model tier on it")
  }

  // Leftovers from a kept stack or a crashed run would otherwise leak state
  // into this run's supposedly fresh volumes.
  await compose(mode, ["down", "-v", "--remove-orphans"], 300_000).catch(() => {})

  // Before build, not before up: compose refuses to interpolate the storage
  // mount at all while the directory is absent.
  resetProjectDir()

  console.log(`[harness] building images (${mode} mode)...`)
  await compose(mode, ["build"], BUILD_TIMEOUT_MS)

  console.log("[harness] starting stack...")
  try {
    await compose(mode, ["up", "-d"], 300_000)
    console.log("[harness] waiting for readiness...")
    await waitForReady(baseUrl())
  } catch (err) {
    await dumpLogs(mode)
    if (!process.env.NABU_E2E_KEEP) {
      await compose(mode, ["down", "-v", "--remove-orphans"], 300_000).catch(() => {})
    } else {
      console.error(`[harness] NABU_E2E_KEEP set; stack left up. Remove with:\n  ${teardownCommand(mode)}`)
    }
    throw err
  }

  writeState({ baseURL: baseUrl(), tier, mode })
  process.env.NABU_E2E_BASE_URL = baseUrl()
  console.log(`[harness] ready at ${baseUrl()} (tier ${tier}, mode ${mode})`)
}
