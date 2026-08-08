const isMapping = (v) => typeof v === "object" && v !== null && !Array.isArray(v)

const partText = (part) => (isMapping(part) && typeof part.text === "string" ? part.text : "")

// Items echoed back from earlier streams arrive in shapes the fixture schema
// never defined, so text is pulled from whichever text-bearing fields exist
// rather than by item type.
const itemText = (item) => {
  if (typeof item === "string") return item
  if (!isMapping(item)) return ""
  const pieces = []
  if (typeof item.content === "string") pieces.push(item.content)
  else if (Array.isArray(item.content)) pieces.push(...item.content.map(partText))
  if (typeof item.arguments === "string") pieces.push(item.arguments)
  if (typeof item.output === "string") pieces.push(item.output)
  return pieces.filter(Boolean).join("\n")
}

export const extractText = (body) => {
  const input = isMapping(body) ? body.input : undefined
  if (typeof input === "string") return input
  if (!Array.isArray(input)) return ""
  return input.map(itemText).filter(Boolean).join("\n")
}

export const matchFixture = (fixtures, path, text) => {
  const candidates = fixtures.filter(
    (f) => f.endpoint === path && f.contains.every((s) => text.includes(s))
  )
  if (candidates.length === 0) return { kind: "unmatched" }
  const max = Math.max(...candidates.map((f) => f.contains.length))
  const top = candidates.filter((f) => f.contains.length === max)
  if (top.length > 1) return { kind: "tie", files: top.map((f) => f.file) }
  return { kind: "match", fixture: top[0] }
}
