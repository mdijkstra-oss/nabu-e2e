import { defineConfig, devices } from "@playwright/test"
import { baseUrl } from "./harness/env"
import { labelsForTier, tagRegex } from "./harness/claims"

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./harness/setup.ts",
  globalTeardown: "./harness/teardown.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  workers: process.env.CI ? 2 : 4,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["./reporter/coverage.ts"]],
  use: {
    baseURL: baseUrl(),
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  projects: [
    {
      name: "stack",
      grep: tagRegex(labelsForTier("stack")),
    },
    {
      name: "stubbed",
      grep: tagRegex(labelsForTier("stubbed"), ["walking skeleton"]),
    },
    {
      name: "real",
      grep: tagRegex(labelsForTier("real"), ["@smoke"]),
    },
  ],
})
