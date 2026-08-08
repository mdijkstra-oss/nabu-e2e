let responseCounter = 0

const CHUNK_SIZE = 16

const chunk = (s) => {
  if (s === "") return [""]
  const out = []
  for (let i = 0; i < s.length; i += CHUNK_SIZE) out.push(s.slice(i, i + CHUNK_SIZE))
  return out
}

const responseObject = (id, status, output, error = null) => ({
  id,
  object: "response",
  created_at: Math.floor(Date.now() / 1000),
  status,
  error,
  incomplete_details: null,
  instructions: null,
  max_output_tokens: null,
  model: "fake-model",
  output,
  parallel_tool_calls: true,
  previous_response_id: null,
  reasoning: null,
  store: false,
  temperature: null,
  text: { format: { type: "text" } },
  tool_choice: "auto",
  tools: [],
  top_p: null,
  truncation: "disabled",
  usage:
    status === "completed"
      ? {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 2,
        }
      : null,
  user: null,
  metadata: {},
})

const buildScriptedEvents = (reply, callIdStem) => {
  const rid = `resp_${++responseCounter}`
  let sequenceNumber = 0
  const ev = (event, data) => ({
    event,
    data: { type: event, sequence_number: sequenceNumber++, ...data },
  })

  if (reply.error !== undefined) {
    return [
      ev("response.created", { response: responseObject(rid, "in_progress", []) }),
      ev("response.failed", {
        response: responseObject(rid, "failed", [], {
          message: reply.error.message,
          type: reply.error.type,
        }),
      }),
    ]
  }

  const events = []
  const output = []
  let outputIndex = 0
  events.push(ev("response.created", { response: responseObject(rid, "in_progress", []) }))
  events.push(ev("response.in_progress", { response: responseObject(rid, "in_progress", []) }))

  const text = reply.json !== undefined ? JSON.stringify(reply.json) : reply.text
  if (text !== undefined) {
    const itemId = `${rid}_msg`
    events.push(
      ev("response.output_item.added", {
        output_index: outputIndex,
        item: { id: itemId, type: "message", role: "assistant", status: "in_progress", content: [] },
      })
    )
    events.push(
      ev("response.content_part.added", {
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      })
    )
    for (const delta of chunk(text)) {
      events.push(
        ev("response.output_text.delta", {
          item_id: itemId,
          output_index: outputIndex,
          content_index: 0,
          delta,
        })
      )
    }
    events.push(
      ev("response.output_text.done", {
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        text,
      })
    )
    events.push(
      ev("response.content_part.done", {
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text, annotations: [] },
      })
    )
    const doneItem = {
      id: itemId,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }
    events.push(ev("response.output_item.done", { output_index: outputIndex, item: doneItem }))
    output.push(doneItem)
    outputIndex++
  }

  for (const [i, call] of (reply.toolCalls ?? []).entries()) {
    const callId = call.callId ?? `call_${callIdStem}_${i + 1}`
    const itemId = `${rid}_fc_${i}`
    const argsJson = JSON.stringify(call.args ?? {})
    events.push(
      ev("response.output_item.added", {
        output_index: outputIndex,
        item: {
          id: itemId,
          type: "function_call",
          call_id: callId,
          name: call.name,
          arguments: "",
          status: "in_progress",
        },
      })
    )
    for (const delta of chunk(argsJson)) {
      events.push(
        ev("response.function_call_arguments.delta", {
          item_id: itemId,
          output_index: outputIndex,
          delta,
        })
      )
    }
    events.push(
      ev("response.function_call_arguments.done", {
        item_id: itemId,
        output_index: outputIndex,
        arguments: argsJson,
      })
    )
    const doneItem = {
      id: itemId,
      type: "function_call",
      call_id: callId,
      name: call.name,
      arguments: argsJson,
      status: "completed",
    }
    events.push(ev("response.output_item.done", { output_index: outputIndex, item: doneItem }))
    output.push(doneItem)
    outputIndex++
  }

  events.push(ev("response.completed", { response: responseObject(rid, "completed", output) }))
  return events
}

// Hold means: everything up to and including the last delta goes out, the
// closing events never do, and the connection stays open until the client
// walks away.
const truncateForHold = (events) => {
  const lastDelta = events.findLastIndex((e) => e.event.endsWith(".delta"))
  if (lastDelta >= 0) return events.slice(0, lastDelta + 1)
  return events.filter((e) => e.event !== "response.completed" && !e.event.endsWith(".done"))
}

export const planReply = (reply, callIdStem) => {
  const delayMs = reply.delayMs ?? 0
  const interEventMs = reply.interEventMs ?? 0

  if (reply.error !== undefined && reply.error.status !== undefined) {
    return {
      delayMs,
      immediate: {
        status: reply.error.status,
        body: { error: { message: reply.error.message, type: reply.error.type } },
      },
    }
  }

  const events =
    reply.events !== undefined
      ? reply.events.map((e) => ({ event: e.event, data: e.data }))
      : buildScriptedEvents(reply, callIdStem)

  return {
    delayMs,
    interEventMs,
    hold: reply.hold === true,
    events: reply.hold === true ? truncateForHold(events) : events,
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const sendReply = async (res, plan) => {
  if (plan.delayMs > 0) await sleep(plan.delayMs)
  if (res.destroyed) return

  if (plan.immediate) {
    res.writeHead(plan.immediate.status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(plan.immediate.body))
    return
  }

  // Nagle would coalesce small event frames; each one must leave as written.
  res.socket?.setNoDelay(true)
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  })
  res.flushHeaders()

  for (const [i, e] of plan.events.entries()) {
    if (i > 0 && plan.interEventMs > 0) await sleep(plan.interEventMs)
    if (res.destroyed) return
    res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
  }

  if (plan.hold) {
    if (!res.destroyed) await new Promise((resolve) => res.once("close", resolve))
    return
  }
  res.end()
}
