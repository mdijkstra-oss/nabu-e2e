import fs from "node:fs"
import { STATE_FILE, type Mode, type Tier } from "./env"

export interface HarnessState {
  baseURL: string
  tier: Tier
  mode: Mode
}

export const writeState = (state: HarnessState): void => {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

export const readState = (): HarnessState => {
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error(`${STATE_FILE} missing: the harness global setup did not run or did not finish`)
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as HarnessState
}
