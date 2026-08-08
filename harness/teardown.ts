import { modeForTier, resolveTier } from "./env"
import { compose, teardownCommand } from "./compose"

export default async function globalTeardown(): Promise<void> {
  const mode = modeForTier(resolveTier())
  if (process.env.NABU_E2E_REUSE) return
  if (process.env.NABU_E2E_KEEP) {
    console.log(`[harness] NABU_E2E_KEEP set; stack left up. Remove with:\n  ${teardownCommand(mode)}`)
    return
  }
  await compose(mode, ["down", "-v", "--remove-orphans"], 300_000)
}
