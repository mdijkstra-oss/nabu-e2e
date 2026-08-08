import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "yaml"

const FIXTURE_KEYS = ["endpoint", "contains", "reply", "replies"]
const REPLY_KEYS = ["text", "json", "toolCalls", "error", "events", "delayMs", "interEventMs", "hold"]
const TOOL_CALL_KEYS = ["name", "args", "callId"]
const ERROR_KEYS = ["message", "type", "status"]
const EVENT_KEYS = ["event", "data"]

const isMapping = (v) => typeof v === "object" && v !== null && !Array.isArray(v)

const fail = (file, message) => {
  throw new Error(`fixture ${file}: ${message}`)
}

const checkKeys = (file, obj, allowed, where) => {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(file, `unknown key "${key}" in ${where}`)
  }
}

const validateContains = (file, contains) => {
  if (contains === undefined) return []
  const list = Array.isArray(contains) ? contains : [contains]
  for (const s of list) {
    if (typeof s !== "string") fail(file, `"contains" entries must be strings`)
    if (s.length === 0) fail(file, `"contains" holds an empty string`)
  }
  return list
}

const validateToolCalls = (file, calls, where) => {
  if (!Array.isArray(calls) || calls.length === 0)
    fail(file, `"toolCalls" in ${where} must be a non-empty list`)
  for (const call of calls) {
    if (!isMapping(call)) fail(file, `"toolCalls" entries in ${where} must be mappings`)
    checkKeys(file, call, TOOL_CALL_KEYS, `"toolCalls" entry of ${where}`)
    if (typeof call.name !== "string" || call.name === "")
      fail(file, `"toolCalls" entry in ${where} needs a "name" string`)
    if (call.args === undefined) fail(file, `"toolCalls" entry in ${where} needs "args"`)
    if (call.callId !== undefined && typeof call.callId !== "string")
      fail(file, `"callId" in ${where} must be a string`)
  }
}

const validateError = (file, error, where) => {
  if (!isMapping(error)) fail(file, `"error" in ${where} must be a mapping`)
  checkKeys(file, error, ERROR_KEYS, `"error" of ${where}`)
  if (typeof error.message !== "string" || error.message === "")
    fail(file, `"error" in ${where} needs a "message" string`)
  if (typeof error.type !== "string" || error.type === "")
    fail(file, `"error" in ${where} needs a "type" string`)
  if (error.status !== undefined && (!Number.isInteger(error.status) || error.status < 300 || error.status > 599))
    fail(file, `"error.status" in ${where} must be a non-2xx HTTP status code`)
}

const validateEvents = (file, events, where) => {
  if (!Array.isArray(events) || events.length === 0)
    fail(file, `"events" in ${where} must be a non-empty list`)
  for (const e of events) {
    if (!isMapping(e)) fail(file, `"events" entries in ${where} must be mappings`)
    checkKeys(file, e, EVENT_KEYS, `"events" entry of ${where}`)
    if (typeof e.event !== "string" || e.event === "")
      fail(file, `"events" entry in ${where} needs an "event" string`)
    if (!("data" in e)) fail(file, `"events" entry in ${where} needs "data"`)
  }
}

const validateMs = (file, value, field, where) => {
  if (value === undefined) return
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    fail(file, `"${field}" in ${where} must be a non-negative number`)
}

const validateReply = (file, reply, where) => {
  if (!isMapping(reply)) fail(file, `${where} must be a mapping`)
  checkKeys(file, reply, REPLY_KEYS, where)

  const bodies = ["text", "json", "events"].filter((k) => reply[k] !== undefined)
  if (bodies.length > 1)
    fail(file, `${where} sets ${bodies.map((k) => `"${k}"`).join(" and ")}; at most one of "text"/"json"/"events"`)

  if (reply.text !== undefined && typeof reply.text !== "string")
    fail(file, `"text" in ${where} must be a string`)
  if (bodies.includes("json") && reply.json === null)
    fail(file, `"json" in ${where} must not be null`)

  if (reply.toolCalls !== undefined) {
    if (reply.events !== undefined)
      fail(file, `${where} combines "toolCalls" with "events"; "toolCalls" combines only with "text" or "json"`)
    validateToolCalls(file, reply.toolCalls, where)
  }

  if (reply.error !== undefined) {
    const others = ["text", "json", "events", "toolCalls"].filter((k) => reply[k] !== undefined)
    if (others.length > 0)
      fail(file, `${where} combines "error" with ${others.map((k) => `"${k}"`).join(" and ")}; "error" stands alone`)
    validateError(file, reply.error, where)
  }

  if (reply.events !== undefined) validateEvents(file, reply.events, where)
  validateMs(file, reply.delayMs, "delayMs", where)
  validateMs(file, reply.interEventMs, "interEventMs", where)
  if (reply.hold !== undefined && typeof reply.hold !== "boolean")
    fail(file, `"hold" in ${where} must be a boolean`)

  if (reply.text === undefined && reply.json === undefined && reply.events === undefined &&
      reply.toolCalls === undefined && reply.error === undefined)
    fail(file, `${where} needs one of "text", "json", "toolCalls", "error", or "events"`)
}

const validateFixture = (file, doc) => {
  if (!isMapping(doc)) fail(file, "top level must be a mapping")
  checkKeys(file, doc, FIXTURE_KEYS, "fixture")

  if (doc.endpoint === undefined) fail(file, `missing "endpoint"`)
  if (typeof doc.endpoint !== "string" || !doc.endpoint.startsWith("/"))
    fail(file, `"endpoint" must be a path starting with "/"`)
  if (doc.endpoint === "/llm" || doc.endpoint.startsWith("/llm/"))
    fail(file, `"endpoint" still carries the "/llm" prefix the proxy strips; use "${doc.endpoint.slice(4) || "/"}"`)

  if (doc.reply !== undefined && doc.replies !== undefined)
    fail(file, `sets both "reply" and "replies"`)
  if (doc.reply === undefined && doc.replies === undefined)
    fail(file, `needs "reply" or "replies"`)

  const contains = validateContains(file, doc.contains)

  let replies
  if (doc.reply !== undefined) {
    validateReply(file, doc.reply, `"reply"`)
    replies = [doc.reply]
  } else {
    if (!Array.isArray(doc.replies) || doc.replies.length === 0)
      fail(file, `"replies" must be a non-empty list`)
    doc.replies.forEach((r, i) => validateReply(file, r, `"replies[${i}]"`))
    replies = doc.replies
  }

  return { file, endpoint: doc.endpoint, contains, replies, served: 0 }
}

export const loadFixtures = (dir) => {
  let names
  try {
    names = readdirSync(dir)
  } catch (e) {
    throw new Error(`fixtures directory ${dir}: ${e.message}`)
  }
  const fixtures = []
  for (const name of names.sort()) {
    if (!/\.ya?ml$/i.test(name)) continue
    const raw = readFileSync(join(dir, name), "utf8")
    let doc
    try {
      doc = parse(raw)
    } catch (e) {
      fail(name, `unparseable YAML — ${e.message.split("\n")[0]}`)
    }
    fixtures.push(validateFixture(name, doc))
  }
  return fixtures
}
