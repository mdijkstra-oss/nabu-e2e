import { COMPOSE_PROJECT } from "./env"
import { exec } from "./compose"

// Storage's HTTP surface has no file-read endpoint and its image is scratch
// with no shell, so on-disk claims read the volume through a one-shot
// container instead.
export const readVolumeFile = async (relPath: string): Promise<string> => {
  const { stdout } = await exec("docker", [
    "run",
    "--rm",
    "-v",
    `${COMPOSE_PROJECT}_projects:/data:ro`,
    "alpine:3",
    "cat",
    `/data/${relPath}`,
  ])
  return stdout
}

export const listVolumeDir = async (relPath: string): Promise<string[]> => {
  const { stdout } = await exec("docker", [
    "run",
    "--rm",
    "-v",
    `${COMPOSE_PROJECT}_projects:/data:ro`,
    "alpine:3",
    "ls",
    "-1a",
    `/data/${relPath}`,
  ])
  return stdout.split("\n").filter((l) => l && l !== "." && l !== "..")
}
