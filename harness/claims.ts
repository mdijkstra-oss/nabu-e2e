import fs from "node:fs"
import path from "node:path"
import { nabuRoot, type Tier } from "./env"

export const CLAIMS_FILE = path.join(nabuRoot, "frontend-behavior-claims.md")

const TIER_BY_MARKER: Record<string, Tier> = {
  "💾": "stack",
  "🎭": "stubbed",
  "🔌": "real",
}

export interface Claim {
  label: string
  tier: Tier
}

// The tier emoji in the claims file is the sole source of truth for which
// Playwright project a claim's tests belong to.
export const parseClaims = (): Claim[] => {
  const text = fs.readFileSync(CLAIMS_FILE, "utf8")
  const claims: Claim[] = []
  for (const line of text.split("\n")) {
    const m = line.match(/^- \[.\] (💾|🎭|🔌) ([A-Z]\d+)\./u)
    if (m) claims.push({ label: m[2], tier: TIER_BY_MARKER[m[1]] })
  }
  if (claims.length === 0) throw new Error(`no claims parsed from ${CLAIMS_FILE}`)
  return claims
}

export const labelsForTier = (tier: Tier): string[] =>
  parseClaims()
    .filter((c) => c.tier === tier)
    .map((c) => c.label)

export const tagRegex = (labels: string[], extra: string[] = []): RegExp =>
  new RegExp([...labels.map((l) => `@${l}\\b`), ...extra].join("|"))
