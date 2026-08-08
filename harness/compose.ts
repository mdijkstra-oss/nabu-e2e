import { execFile } from "node:child_process"
import path from "node:path"
import { COMPOSE_PROJECT, composeEnv, e2eRoot, selfHostedDir, type Mode } from "./env"

const MIN_COMPOSE = [2, 24, 4]

export interface ExecResult {
  stdout: string
  stderr: string
}

export const exec = (
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {}
): Promise<ExecResult> =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        env: { ...process.env, ...opts.env },
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 64 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} ${args.join(" ")} failed:\n${stderr || stdout}\n${err.message}`))
        else resolve({ stdout, stderr })
      }
    )
  })

export const composeArgs = (mode: Mode, ...rest: string[]): string[] => {
  const args = ["compose", "-p", COMPOSE_PROJECT, "-f", path.join(selfHostedDir, "compose.yaml")]
  if (mode === "override") args.push("-f", path.join(e2eRoot, "compose.e2e.yaml"))
  return [...args, ...rest]
}

export const compose = (mode: Mode, args: string[], timeoutMs?: number): Promise<ExecResult> =>
  exec("docker", composeArgs(mode, ...args), { env: composeEnv(mode), timeoutMs })

export const checkComposeVersion = async (): Promise<void> => {
  const { stdout } = await exec("docker", ["compose", "version", "--short"])
  const parts = stdout.trim().replace(/^v/, "").split(".").map(Number)
  for (let i = 0; i < MIN_COMPOSE.length; i++) {
    const have = parts[i] ?? 0
    if (have > MIN_COMPOSE[i]) return
    if (have < MIN_COMPOSE[i]) {
      throw new Error(
        `docker compose ${stdout.trim()} is older than 2.24.4; the override file needs the !reset/!override merge tags`
      )
    }
  }
}

export const teardownCommand = (mode: Mode): string =>
  ["docker", ...composeArgs(mode, "down", "-v", "--remove-orphans")].join(" ")
