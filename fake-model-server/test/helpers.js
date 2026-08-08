import { execFile } from "node:child_process"
import net from "node:net"
import { promisify } from "node:util"

const execFileP = promisify(execFile)

export const IMAGE = process.env.FAKE_MODEL_SERVER_IMAGE ?? "nabu-e2e-fake-model-server:dev"

export const docker = (...args) => execFileP("docker", args, { timeout: 60_000 })

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const waitFor = async (fn, { timeoutMs = 20_000, stepMs = 100 } = {}) => {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (e) {
      lastError = e
    }
    await sleep(stepMs)
  }
  throw new Error(`waitFor timed out${lastError ? `: ${lastError}` : ""}`)
}

export const startContainer = async (fixturesDir) => {
  const llmPort = await freePort()
  const embPort = await freePort()
  const { stdout } = await docker(
    "run", "-d", "--rm",
    "-p", `127.0.0.1:${llmPort}:8081`,
    "-p", `127.0.0.1:${embPort}:8082`,
    "-v", `${fixturesDir}:/fixtures:ro`,
    IMAGE
  )
  const id = stdout.trim()
  const ctx = {
    id,
    llm: `http://127.0.0.1:${llmPort}`,
    emb: `http://127.0.0.1:${embPort}`,
    stop: async () => {
      try {
        await docker("stop", "-t", "1", id)
      } catch {
        // already gone
      }
    },
  }
  try {
    await waitFor(
      async () => (await fetch(`${ctx.llm}/health`)).ok && (await fetch(`${ctx.emb}/health`)).ok
    )
  } catch (e) {
    await ctx.stop()
    throw e
  }
  return ctx
}

export const llmBody = (text) =>
  JSON.stringify({
    input: [
      { type: "message", role: "system", content: "You are a coder." },
      { type: "message", role: "user", content: [{ type: "input_text", text }] },
    ],
    stream: true,
  })

export const postLlm = (ctx, path, text, headers = {}) =>
  fetch(`${ctx.llm}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-ID": "sess-test", ...headers },
    body: llmBody(text),
  })

export const postEmbeddings = (ctx, body, headers = {}) =>
  fetch(`${ctx.emb}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-ID": "sess-test", ...headers },
    body: JSON.stringify(body),
  })

export const parseSse = (raw) => {
  const events = []
  let event = null
  let data = null
  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7)
    else if (line.startsWith("data: ")) data = line.slice(6)
    else if (line === "" && event !== null) {
      events.push({ event, data: data === null ? null : JSON.parse(data) })
      event = null
      data = null
    }
  }
  return events
}

export const deltaText = (events) =>
  events
    .filter((e) => e.event === "response.output_text.delta")
    .map((e) => e.data.delta)
    .join("")

export const getJournal = async (base, project) => {
  const res = await fetch(
    `${base}/_e2e/journal${project ? `?project=${encodeURIComponent(project)}` : ""}`
  )
  if (!res.ok) throw new Error(`journal read failed: ${res.status}`)
  return res.json()
}
