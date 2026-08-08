import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import OpenAI from "openai"
import {
  IMAGE,
  docker,
  startContainer,
  postLlm,
  postEmbeddings,
  parseSse,
  deltaText,
  getJournal,
} from "./helpers.js"

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures")

describe("fake-model-server contract", { timeout: 120_000 }, () => {
  let ctx

  before(async () => {
    ctx = await startContainer(join(fixturesRoot, "valid"))
  })

  after(async () => {
    await ctx?.stop()
  })

  it("skeleton leg: health, wget, embeddings then a matched chat turn, journaled in order", async () => {
    assert.equal((await fetch(`${ctx.llm}/health`)).status, 200)
    assert.equal((await fetch(`${ctx.emb}/health`)).status, 200)

    // The compose healthcheck execs wget inside the container; prove the binary works there.
    await docker("exec", ctx.id, "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8082/health")

    const embRes = await postEmbeddings(
      ctx,
      { input: ["boot corpus chunk one", "boot corpus chunk two"], model: "fake-embed", dimensions: 32 },
      { "X-Project-ID": "skeleton" }
    )
    assert.equal(embRes.status, 200)

    const chatRes = await postLlm(ctx, "/qual-coder", "please handle MARKER-SKELETON now", {
      "X-Project-ID": "skeleton",
    })
    assert.equal(chatRes.status, 200)
    assert.match(chatRes.headers.get("content-type"), /^text\/event-stream/)
    const events = parseSse(await chatRes.text())
    assert.equal(deltaText(events), "Skeleton marker reply from the fixture.")
    assert.equal(events[0].event, "response.created")
    assert.equal(events.at(-1).event, "response.completed")

    const entries = await getJournal(ctx.llm, "skeleton")
    assert.equal(entries.length, 2)
    const [embEntry, chatEntry] = entries
    assert.equal(embEntry.path, "/embeddings")
    assert.equal(chatEntry.path, "/qual-coder")
    assert.ok(embEntry.seq < chatEntry.seq)
    assert.equal(chatEntry.fixture, "qual-coder.yaml")
  })

  it("case 1: unmatched request fails loud with 501 and a null-fixture journal entry", async () => {
    const res = await postLlm(ctx, "/no-such-prompt", "anything at all", {
      "X-Project-ID": "case1",
    })
    assert.equal(res.status, 501)
    const body = await res.json()
    assert.equal(body.error.type, "e2e_unmatched")
    assert.match(body.error.message, /\/no-such-prompt/)
    assert.match(body.error.message, /\d+ fixture/)

    const entries = await getJournal(ctx.llm, "case1")
    assert.equal(entries.length, 1)
    assert.equal(entries[0].path, "/no-such-prompt")
    assert.equal(entries[0].fixture, null)
    assert.ok(entries[0].body !== null)
  })

  it("case 1b: a tie between fixtures fails loud naming both files", async () => {
    const res = await postLlm(ctx, "/tie", "this has TIE-MARKER inside", {
      "X-Project-ID": "case1-tie",
    })
    assert.equal(res.status, 501)
    const body = await res.json()
    assert.equal(body.error.type, "e2e_unmatched")
    assert.match(body.error.message, /tie-a\.yaml/)
    assert.match(body.error.message, /tie-b\.yaml/)

    const entries = await getJournal(ctx.llm, "case1-tie")
    assert.equal(entries.length, 1)
    assert.equal(entries[0].fixture, null)
  })

  it("case 3: the official OpenAI client streams the fixture text and completes", async () => {
    const client = new OpenAI({ apiKey: "test-key", baseURL: ctx.llm, maxRetries: 0 })
    const stream = client.responses.stream({
      model: "fake-model",
      input: "ping from the official client",
    })
    let streamed = ""
    stream.on("response.output_text.delta", (e) => {
      streamed += e.delta
    })
    const final = await stream.finalResponse()

    const expected = "Streaming straight from the fake model server, chunk by chunk."
    assert.equal(streamed, expected)
    assert.equal(final.status, "completed")
    assert.equal(final.output[0].content[0].text, expected)

    const entries = await getJournal(ctx.llm)
    const entry = entries.findLast((e) => e.path === "/responses")
    assert.equal(entry.fixture, "responses.yaml")
  })

  it("case 4: tool-call framing lands the call from output_item.done with string arguments", async () => {
    const res = await postLlm(ctx, "/tool-caller", "please MARKER-TOOL now", {
      "X-Project-ID": "case4",
    })
    assert.equal(res.status, 200)
    const events = parseSse(await res.text())

    assert.equal(events[0].event, "response.created")
    assert.equal(events.at(-1).event, "response.completed")
    for (const e of events) assert.ok(e.data !== null, `event ${e.event} carries single-line JSON data`)

    const added = events.filter(
      (e) => e.event === "response.output_item.added" && e.data.item?.type === "function_call"
    )
    assert.equal(added.length, 2)
    assert.equal(added[0].data.item.name, "query")

    const argDeltas = events.filter((e) => e.event === "response.function_call_arguments.delta")
    assert.ok(argDeltas.length >= 2)
    const firstArgs = argDeltas
      .filter((e) => e.data.item_id === added[0].data.item.id)
      .map((e) => e.data.delta)
      .join("")
    assert.deepEqual(JSON.parse(firstArgs), { sql: "select 1" })

    const done = events.filter(
      (e) => e.event === "response.output_item.done" && e.data.item?.type === "function_call"
    )
    assert.equal(done.length, 2)
    const item = done[0].data.item
    assert.equal(item.type, "function_call")
    assert.equal(item.call_id, "call-fixed-1")
    assert.equal(item.name, "query")
    assert.equal(typeof item.arguments, "string")
    assert.deepEqual(JSON.parse(item.arguments), { sql: "select 1" })
    // Omitted callId falls back to a deterministic generated id.
    assert.equal(done[1].data.item.call_id, "call_tool-call_2")

    // added announces the name before any of its argument deltas, which precede its done.
    const idx = (pred) => events.findIndex(pred)
    const addedIdx = idx((e) => e.event === "response.output_item.added" && e.data.item?.id === item.id)
    const firstDeltaIdx = idx(
      (e) => e.event === "response.function_call_arguments.delta" && e.data.item_id === item.id
    )
    const doneIdx = idx((e) => e.event === "response.output_item.done" && e.data.item?.id === item.id)
    assert.ok(addedIdx < firstDeltaIdx && firstDeltaIdx < doneIdx)

    // text streams first, tool calls after.
    assert.ok(
      idx((e) => e.event === "response.output_text.delta") < addedIdx,
      "text deltas precede the tool call items"
    )
  })

  it("case 5: a held slow stream survives client abort; the server moves on", async () => {
    const res = await postLlm(ctx, "/holder", "start MARKER-HOLD stream", {
      "X-Project-ID": "case5",
    })
    assert.equal(res.status, 200)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    while (!buf.includes("response.output_text.delta")) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
    }
    await reader.cancel()

    const entries = await getJournal(ctx.llm, "case5")
    assert.equal(entries.length, 1)
    assert.equal(entries[0].path, "/holder")
    assert.equal(entries[0].fixture, "hold.yaml")

    // The connection is released: an immediately following request answers normally.
    const follow = await postLlm(ctx, "/qual-coder", "MARKER-SKELETON follow-up", {
      "X-Project-ID": "case5",
    })
    assert.equal(follow.status, 200)
    assert.equal(deltaText(parseSse(await follow.text())), "Skeleton marker reply from the fixture.")
  })

  it("case 6: embedding vectors are deterministic, unit length, and exactly dimensions wide", async () => {
    const a = await (
      await postEmbeddings(ctx, {
        input: ["alpha string", "beta string"],
        model: "fake-embed",
        dimensions: 64,
      })
    ).json()
    const b = await (
      await postEmbeddings(ctx, {
        input: ["gamma", "alpha string", "delta", "epsilon"],
        model: "fake-embed",
        dimensions: 64,
      })
    ).json()

    assert.equal(a.data.length, 2)
    assert.deepEqual(a.data.map((d) => d.index), [0, 1])
    assert.equal(typeof a.usage.total_tokens, "number")

    const alphaInBatchA = a.data[0].embedding
    const alphaInBatchB = b.data[1].embedding
    assert.equal(alphaInBatchA.length, 64)
    assert.deepEqual(alphaInBatchA, alphaInBatchB)
    assert.notDeepEqual(a.data[0].embedding, a.data[1].embedding)

    const norm = Math.sqrt(alphaInBatchA.reduce((s, v) => s + v * v, 0))
    assert.ok(Math.abs(norm - 1) < 1e-9)

    const wide = await (
      await postEmbeddings(ctx, { input: ["alpha string"], model: "fake-embed", dimensions: 128 })
    ).json()
    assert.equal(wide.data[0].embedding.length, 128)

    const missing = await postEmbeddings(ctx, { input: ["x"], model: "fake-embed" })
    assert.equal(missing.status, 400)
    assert.match(await missing.text(), /dimensions/)
  })

  it("case 7: concurrent posts on both surfaces journal exactly once with gapless seq", async () => {
    const N = 20
    const posts = []
    for (let i = 0; i < N; i++) {
      posts.push(
        postLlm(ctx, "/responses", `concurrent llm ${i}`, { "X-Project-ID": `case7-llm-${i}` }).then(
          (r) => r.text()
        )
      )
      posts.push(
        postEmbeddings(
          ctx,
          { input: [`concurrent emb ${i}`], model: "fake-embed", dimensions: 8 },
          { "X-Project-ID": `case7-emb-${i}` }
        ).then((r) => r.json())
      )
    }
    await Promise.all(posts)

    const fromLlm = await getJournal(ctx.llm)
    const fromEmb = await getJournal(ctx.emb)
    assert.deepEqual(fromEmb, fromLlm, "one journal, readable on both ports")

    const seqs = fromLlm.map((e) => e.seq)
    assert.equal(new Set(seqs).size, seqs.length)
    assert.deepEqual(
      [...seqs].sort((x, y) => x - y),
      Array.from({ length: seqs.length }, (_, i) => i + 1),
      "seq is gapless from 1"
    )

    for (let i = 0; i < N; i++) {
      const llmEntries = await getJournal(ctx.llm, `case7-llm-${i}`)
      assert.equal(llmEntries.length, 1)
      assert.equal(llmEntries[0].path, "/responses")
      const embEntries = await getJournal(ctx.emb, `case7-emb-${i}`)
      assert.equal(embEntries.length, 1)
      assert.equal(embEntries[0].path, "/embeddings")
    }
  })

  it("case 8: the fixture with more contains strings wins", async () => {
    const res = await postLlm(ctx, "/precedence", "text with ALPHA and BETA markers", {
      "X-Project-ID": "case8",
    })
    assert.equal(res.status, 200)
    assert.equal(deltaText(parseSse(await res.text())), "superset fixture answered")

    const entries = await getJournal(ctx.llm, "case8")
    assert.equal(entries.length, 1)
    assert.equal(entries[0].fixture, "precedence-superset.yaml")

    // The subset fixture still answers when only its own string is present.
    const subsetRes = await postLlm(ctx, "/precedence", "text with ALPHA alone", {
      "X-Project-ID": "case8-subset",
    })
    assert.equal(deltaText(parseSse(await subsetRes.text())), "subset fixture answered")
  })

  it("extras: replies rotate and the last repeats", async () => {
    const texts = []
    for (let i = 0; i < 3; i++) {
      const res = await postLlm(ctx, "/rotation", `turn ${i}`, { "X-Project-ID": "extras-rotation" })
      texts.push(deltaText(parseSse(await res.text())))
    }
    assert.deepEqual(texts, ["first reply", "second reply", "second reply"])
  })

  it("extras: error with status answers immediately, error without status streams response.failed", async () => {
    const immediate = await postLlm(ctx, "/error-status", "boom", { "X-Project-ID": "extras-err" })
    assert.equal(immediate.status, 429)
    assert.deepEqual(await immediate.json(), {
      error: { message: "quota exhausted", type: "rate_limited" },
    })

    const streamed = await postLlm(ctx, "/error-stream", "boom", { "X-Project-ID": "extras-err" })
    assert.equal(streamed.status, 200)
    assert.match(streamed.headers.get("content-type"), /^text\/event-stream/)
    const events = parseSse(await streamed.text())
    const failed = events.find((e) => e.event === "response.failed")
    assert.deepEqual(failed.data.response.error, { message: "safety filter tripped", type: "SAFETY" })
    assert.ok(!events.some((e) => e.event === "response.completed"))
  })

  it("extras: json replies stream as output-text deltas of one serialization", async () => {
    const res = await postLlm(ctx, "/json-reply", "judge this", { "X-Project-ID": "extras-json" })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(deltaText(parseSse(await res.text()))), { verdict: "pass", score: 3 })
  })

  it("extras: a non-JSON body fails loud and journals with body null", async () => {
    const res = await fetch(`${ctx.llm}/qual-coder`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Project-ID": "extras-nonjson" },
      body: "not json at all {",
    })
    assert.equal(res.status, 400)
    const entries = await getJournal(ctx.llm, "extras-nonjson")
    assert.equal(entries.length, 1)
    assert.equal(entries[0].body, null)
    assert.equal(entries[0].fixture, null)
  })
})

describe("case 2: invalid fixtures die at boot", { timeout: 120_000 }, () => {
  const boots = [
    ["invalid-unknown-key", "unknown-key.yaml", /bogus/],
    ["invalid-missing-endpoint", "missing-endpoint.yaml", /endpoint/],
    ["invalid-both", "both-reply-and-replies.yaml", /"reply" and "replies"/],
  ]

  for (const [dir, file, fieldPattern] of boots) {
    it(`${dir} exits nonzero naming ${file} and the field`, async () => {
      let failure
      try {
        await docker("run", "--rm", "-v", `${join(fixturesRoot, dir)}:/fixtures:ro`, IMAGE)
      } catch (e) {
        failure = e
      }
      assert.ok(failure, "container run must fail")
      assert.notEqual(failure.code, 0)
      assert.match(failure.stderr, new RegExp(file.replace(/\./g, "\\.")))
      assert.match(failure.stderr, fieldPattern)
      assert.ok(!failure.stdout.includes("LLM surface"), "serves nothing")
    })
  }
})
