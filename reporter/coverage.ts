import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from "@playwright/test/reporter"
import { parseClaims, type Claim } from "../harness/claims"
import type { Tier } from "../harness/env"

interface Row {
  claim: string
  tier: Tier
  tests: string[]
  verdict: "pass" | "fail" | "untested"
}

const TIER_MARKER: Record<Tier, string> = { stack: "💾", stubbed: "🎭", real: "🔌" }

// --grep or positional file arguments mean the human narrowed the run; the
// reporter then only speaks about the claims the filter touched and never
// fails on the others' absence.
const isFilteredRun = (): boolean =>
  process.argv.some(
    (a, i) =>
      a === "--grep" ||
      a === "-g" ||
      a.startsWith("--grep=") ||
      (i > 1 && !a.startsWith("-") && (a.endsWith(".ts") || a.includes("/")) && !a.includes("node_modules"))
  )

export default class CoverageReporter implements Reporter {
  private claims: Claim[] = []
  private projectsRun = new Set<string>()
  private byLabel = new Map<string, { titles: string[]; failed: boolean }>()

  onBegin(_config: FullConfig, suite: Suite) {
    this.claims = parseClaims()
    for (const test of suite.allTests()) {
      const project = test.parent.project()?.name
      if (project) this.projectsRun.add(project)
    }
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const labels = [...new Set(test.tags.map((t) => t.replace(/^@/, "")))]
    const failed = result.status !== "passed" && result.status !== "skipped"
    for (const label of labels) {
      const entry = this.byLabel.get(label) ?? { titles: [], failed: false }
      if (!entry.titles.includes(test.title)) entry.titles.push(test.title)
      entry.failed = entry.failed || failed
      this.byLabel.set(label, entry)
    }
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult["status"] } | void> {
    const filtered = isFilteredRun()
    const rows: Row[] = []

    for (const claim of this.claims) {
      if (!this.projectsRun.has(claim.tier)) continue
      const entry = this.byLabel.get(claim.label)
      if (!entry && filtered) continue
      rows.push({
        claim: claim.label,
        tier: claim.tier,
        tests: entry?.titles ?? [],
        verdict: !entry ? "untested" : entry.failed ? "fail" : "pass",
      })
    }

    if (rows.length === 0) return

    console.log("\nClaim coverage:")
    for (const row of rows) {
      const icon = row.verdict === "pass" ? "✅" : row.verdict === "fail" ? "❌" : "⚠️ "
      const tests = row.tests.length > 0 ? row.tests.join(" | ") : "(none)"
      console.log(`  ${icon} ${row.claim} ${TIER_MARKER[row.tier]} ${row.verdict.padEnd(8)} ${tests}`)
    }

    const untested = rows.filter((r) => r.verdict === "untested")
    if (untested.length > 0 && !filtered) {
      console.error(
        `\n${untested.length} claim(s) with no tagged test in an unfiltered run: ${untested.map((r) => r.claim).join(", ")}`
      )
      return { status: "failed" }
    }
    return { status: result.status }
  }
}
