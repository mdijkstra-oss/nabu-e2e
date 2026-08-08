import { createHash } from "node:crypto"

// Counter-mode SHA-256 over the input alone: the same string yields the same
// vector across batches, calls, and restarts, because stored companion files
// outlive the process.
export const embed = (input, dimensions) => {
  const seed = createHash("sha256").update(input, "utf8").digest()
  const values = new Float64Array(dimensions)
  let sumSquares = 0
  let block = null
  let offset = 32
  let blockIndex = 0
  for (let i = 0; i < dimensions; i++) {
    if (offset + 4 > 32) {
      const counter = Buffer.alloc(4)
      counter.writeUInt32BE(blockIndex++)
      block = createHash("sha256").update(seed).update(counter).digest()
      offset = 0
    }
    const v = (block.readUInt32BE(offset) / 0xffffffff) * 2 - 1
    offset += 4
    values[i] = v
    sumSquares += v * v
  }
  const norm = Math.sqrt(sumSquares) || 1
  return Array.from(values, (v) => v / norm)
}
