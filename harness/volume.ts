import fs from "node:fs"
import path from "node:path"
import { PROJECT_DIR } from "./env"

// Storage's HTTP surface has no file-read endpoint, so on-disk claims read the
// bind-mounted host directory the container writes into. Storage renames a
// complete file into place, so a plain read never catches one mid-write.
export const readVolumeFile = async (relPath: string): Promise<string> =>
  fs.promises.readFile(path.join(PROJECT_DIR, relPath), "utf8")

export const listVolumeDir = async (relPath: string): Promise<string[]> =>
  fs.promises.readdir(path.join(PROJECT_DIR, relPath))
