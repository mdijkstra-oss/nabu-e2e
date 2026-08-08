import http from "node:http"
import { loadFixtures } from "./fixtures.js"
import { extractText, matchFixture } from "./match.js"
import { planReply, sendReply } from "./sse.js"
import { embed } from "./embeddings.js"

const FIXTURES_DIR = process.env.FIXTURES_DIR ?? "/fixtures"
const LLM_PORT = 8081
const EMBEDDINGS_PORT = 8082

let fixtures
try {
  fixtures = loadFixtures(FIXTURES_DIR)
} catch (e) {
  console.error(e.message)
  process.exit(1)
}

console.log(
  `loaded ${fixtures.length} fixture(s) from ${FIXTURES_DIR}` +
    fixtures.map((f) => `\n  ${f.file} -> POST ${f.endpoint}`).join("")
)

const journal = []
let nextSeq = 1

const record = (path, req, body, fixture) => {
  journal.push({
    seq: nextSeq++,
    path,
    projectId: req.headers["x-project-id"] ?? null,
    body,
    fixture,
  })
}

const respondJson = (res, status, payload) => {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(payload))
}

const respondError = (res, status, message, type) =>
  respondJson(res, status, { error: { message, type } })

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", () => resolve(null))
  })

const parseJson = (raw) => {
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const journalEntries = (url) => {
  const project = url.searchParams.get("project")
  return project === null ? journal : journal.filter((e) => e.projectId === project)
}

const handleControl = (url, req, res) => {
  if (url.pathname !== "/_e2e/journal") return false
  if (req.method !== "GET") {
    respondError(res, 405, `${req.method} /_e2e/journal: GET only`, "e2e_bad_request")
    return true
  }
  respondJson(res, 200, journalEntries(url))
  return true
}

const handleLlm = async (req, res) => {
  const url = new URL(req.url, "http://localhost")
  const path = url.pathname

  if (handleControl(url, req, res)) return
  if (req.method === "GET" && path === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" })
    res.end("ok")
    return
  }
  if (req.method !== "POST") {
    respondError(
      res,
      404,
      `${req.method} ${path}: this surface serves POST prompt requests, GET /health, and GET /_e2e/journal`,
      "e2e_bad_request"
    )
    return
  }

  const body = parseJson(await readBody(req))
  if (body === null) {
    record(path, req, null, null)
    respondError(res, 400, `POST ${path}: request body is not JSON`, "e2e_bad_request")
    return
  }

  const outcome = matchFixture(fixtures, path, extractText(body))
  if (outcome.kind === "unmatched") {
    record(path, req, body, null)
    respondError(
      res,
      501,
      `no fixture matched POST ${path}; ${fixtures.length} fixture(s) consulted`,
      "e2e_unmatched"
    )
    return
  }
  if (outcome.kind === "tie") {
    record(path, req, body, null)
    respondError(
      res,
      501,
      `POST ${path} matched ${outcome.files.join(" and ")} equally; ${fixtures.length} fixture(s) consulted — tighten "contains" so one fixture wins`,
      "e2e_unmatched"
    )
    return
  }

  const fixture = outcome.fixture
  record(path, req, body, fixture.file)
  const reply = fixture.replies[Math.min(fixture.served++, fixture.replies.length - 1)]
  await sendReply(res, planReply(reply, fixture.file.replace(/\.ya?ml$/i, "")))
}

const handleEmbeddings = async (req, res) => {
  const url = new URL(req.url, "http://localhost")
  const path = url.pathname

  if (handleControl(url, req, res)) return
  if (req.method === "GET" && path === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" })
    res.end("ok")
    return
  }
  if (req.method !== "POST" || path !== "/embeddings") {
    respondError(
      res,
      404,
      `${req.method} ${path}: this surface serves POST /embeddings, GET /health, and GET /_e2e/journal`,
      "e2e_bad_request"
    )
    return
  }

  const body = parseJson(await readBody(req))
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    record(path, req, null, null)
    respondError(res, 400, "POST /embeddings: request body is not a JSON object", "e2e_bad_request")
    return
  }

  record(path, req, body, null)

  const missing = ["input", "model", "dimensions"].filter(
    (k) => body[k] === undefined || body[k] === null
  )
  if (missing.length > 0) {
    respondError(
      res,
      400,
      `POST /embeddings: missing ${missing.map((k) => `"${k}"`).join(", ")}`,
      "e2e_bad_request"
    )
    return
  }
  if (!Array.isArray(body.input) || body.input.some((s) => typeof s !== "string")) {
    respondError(res, 400, `POST /embeddings: "input" must be a list of strings`, "e2e_bad_request")
    return
  }
  if (!Number.isInteger(body.dimensions) || body.dimensions < 1) {
    respondError(res, 400, `POST /embeddings: "dimensions" must be a positive integer`, "e2e_bad_request")
    return
  }

  respondJson(res, 200, {
    data: body.input.map((s, index) => ({ index, embedding: embed(s, body.dimensions) })),
    usage: { total_tokens: body.input.length },
  })
}

const serve = (handler) =>
  http.createServer((req, res) => {
    res.on("error", () => {})
    handler(req, res).catch((e) => {
      console.error(e)
      if (!res.headersSent) respondError(res, 500, String(e), "e2e_internal")
      else res.destroy()
    })
  })

serve(handleLlm).listen(LLM_PORT, () => console.log(`LLM surface on :${LLM_PORT}`))
serve(handleEmbeddings).listen(EMBEDDINGS_PORT, () =>
  console.log(`embeddings surface on :${EMBEDDINGS_PORT}`)
)

// Held connections would otherwise stall docker stop until its kill timeout.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0))
