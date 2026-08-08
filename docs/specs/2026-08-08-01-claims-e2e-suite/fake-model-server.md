# fake-model-server

fake-model-server is the container image the [stubbed tier](spec.md) runs in place of the stack's `chancery` and `embeddings` services: it streams scripted Responses-format SSE for LLM calls, answers embeddings requests with deterministic vectors, and journals every request. The [test-suite](test-suite.md) consumes its fixture files and journal; the [stack-harness](stack-harness.md) mounts the fixtures and wires the container into the compose network.

## Contract

### Placement and ports

One process listens on ports 8081 and 8082, and one container runs it: the [stack-harness](stack-harness.md) runs the image in the `embeddings` service slot with the network alias `chancery`, so the proxy reaches the LLM surface at `chancery:8081` with the `/llm` prefix stripped (`nabu-self-hosted/Caddyfile:42-44`) and the embeddings surface at `embeddings:8082` with the path passed through unchanged (`nabu-self-hosted/Caddyfile:48-50`) — two DNS names, one process. One process means one journal, so arrival order is global across both surfaces.

Port 8081 answers a POST to any path as an LLM prompt request. Port 8082 answers POST `/embeddings` — the literal path, because the proxy's `handle` does not strip it, matching the route the real relay serves (`nabu-embeddings/Caddyfile:25`). Both ports answer GET `/health` with 200. The base compose file probes the embeddings slot by executing wget inside the container (`nabu-self-hosted/compose.yaml:66-71`), so the image ships a `wget` binary — answering HTTP alone would leave the service permanently unhealthy.

The image builds from the component's own directory in `nabu-e2e` — a Dockerfile beside the fixtures it serves — and the [stack-harness](stack-harness.md) builds it as part of override mode.

Fixtures are read once, at startup, from `/fixtures` inside the container, which the harness mounts read-only. The journal lives in memory. A changed fixture file needs a container restart; tests distinguish scenarios by planting marker strings in corpus and message content, not by swapping fixtures mid-run.

### LLM requests

Every LLM request arrives as a POST with `Content-Type: application/json`, an `X-Session-ID` header minted once per app load, and an `X-Project-ID` header once a project is open (`nabu-frontend/app/lib/agent/env.ts:8-17`). The body is `{input, stream: true, tools?, text?: {format}}` (`nabu-frontend/app/lib/agent/client/fetch.ts:141-154`). `stream` is always true (`fetch.ts:150`), so the server always streams.

`input` is an array of items in three authored shapes — `message` with role `system`/`user`/`assistant` and content that is either a string or a list of `input_text` parts, `function_call` with `call_id`/`status`/`name`/`arguments`, and `function_call_output` with `call_id`/`status`/`output` (`nabu-frontend/app/lib/agent/client/convert.ts:5-18`) — plus items echoed back verbatim from earlier streams, so the server must tolerate item shapes it did not define. `tools` entries are flat Responses-style function definitions: `{type: "function", name, description, strict?, parameters}` (`nabu-frontend/app/lib/agent/executors/tool.ts:59-70`).

The server accepts any path and hardcodes none — the prompt set can grow without touching the image, and each fixture's `endpoint` field names the path it answers. The paths the frontend sends today, for fixture authors:

| Path | Built at (`nabu-frontend/app/lib/`) |
| --- | --- |
| `/qual-coder` | `agent/executors/modes.ts:76` |
| `/qual-coder.planning` | `agent/executors/modes.ts:82` |
| `/qual-coder.execution` | `agent/executors/modes.ts:105` |
| `/refine-code` | `agent/tools/refine-code/def.ts:18` |
| `/deep-analysis-filter.voter-one` | `agent/tools/apply-deep-analysis/step-filter.ts:66`, voter names at `def.ts:83` |
| `/deep-analysis-filter.voter-two` | `agent/tools/apply-deep-analysis/step-filter.ts:66` — the filter endpoint is always voter-suffixed, never bare |
| `/deep-analysis-adjudicate` | `agent/tools/apply-deep-analysis/def.ts:80`, used bare at `step-adjudicate.ts:72` |
| `/scout-filter` | `agent/tools/scout-filter/def.ts:3` |
| `/semantic-filter` | `search/verdict.ts:19` |
| `/topic-assigner` | `corpus/classify.ts:5` |
| `/corpus-describer` | `corpus/describe.ts:6` |
| `/hyde-generator` | `corpus/generate-hydes.ts:7` |
| `/generic-hyde` | `corpus/generate-hydes.ts:8` |
| `/file-hyde` | `corpus/generate-file-hydes.ts:14` |

### The stream

A matched request gets a 200 with `Content-Type: text/event-stream` and true OpenAI Responses API framing: an `event:` line naming the event, a `data:` line carrying the payload as JSON, a blank line, each event flushed as it is written. The content type is load-bearing at the proxy: its encode block enumerates the compressible types and deliberately leaves `text/event-stream` out so events pass through unbuffered (`nabu-self-hosted/Caddyfile:7-27`); any other content type would be gzip-buffered and the whole stream would arrive at once.

```text
event: response.output_text.delta
data: {"delta":"The marker "}

```

Every `data:` payload must be a single line: the frontend splits the body on newlines and parses each `data:` line's JSON independently (`nabu-frontend/app/lib/agent/client/fetch.ts:83-97`, `parse.ts:92-101`), so a payload spanning lines is silently dropped. Unknown event names fall through unhandled (`parse.ts:100-178`), which makes spec-complete streams — including `response.created` and `response.completed` — the correct thing to emit.

The events the frontend acts on (`nabu-frontend/app/lib/agent/client/parse.ts:87-179`):

- `response.output_text.delta` — `delta` appends to the answer text (`parse.ts:103-109`).
- `response.output_item.added` — an item of type `function_call` announces the tool name for display (`parse.ts:111-120`).
- `response.function_call_arguments.delta` — streams argument text, display only (`parse.ts:122-127`).
- `response.reasoning_summary_text.delta` — `delta` appends to the reasoning summary (`parse.ts:129-135`).
- `response.failed` — `{response: {error: {message, type}}}` becomes an error block (`parse.ts:138-151`).
- `response.output_item.done` — the only event a tool call lands from: an item `{type: "function_call", call_id, name, arguments}` with `arguments` a JSON string, not an object (`parse.ts:153-163`); an item of type `reasoning` carries `id` and `encrypted_content` back into the transcript (`parse.ts:165-172`).

The exact shape that lands a tool call:

```text
event: response.output_item.done
data: {"item":{"type":"function_call","call_id":"call-1","name":"query","arguments":"{\"sql\":\"select 1\"}"}}

```

A non-2xx response carries the body `{error: {message, type}}`, which the frontend folds into the error it throws and shows (`nabu-frontend/app/lib/agent/client/fetch.ts:41-51`).

### Fixtures

A fixture is one YAML file in the fixtures directory pairing a matcher with one or more scripted replies; the filename is how the journal names it. Matching is stateless — predicates see only the arriving body — so tests plant unique marker strings and let the growing transcript separate turns; the ordered reply list below is the fallback for true sequences.

Fixtures are parsed and validated at startup, and the container refuses to start on the first invalid one, naming the file and the field: unparseable YAML, an unknown key, a missing `endpoint`, an `endpoint` still carrying the `/llm` prefix, an empty `contains` string, both `reply` and `replies`, or more than one of `text`/`json`/`events` in a reply. A fixture that would silently never match is the failure mode the fail-loud design exists to prevent, so it dies at boot, not at match time.

Matcher fields:

| Field | Meaning |
| --- | --- |
| `endpoint` | Required. The path as the server sees it, after the proxy's prefix strip — `/qual-coder`, not `/llm/qual-coder`. |
| `contains` | A string or list of strings; each must appear somewhere in the request's text — message content (string or `input_text` parts), `function_call` arguments, or `function_call_output` output. |

When several fixtures match one request, the one with more `contains` strings answers; a tie between distinct fixtures is answered like an unmatched request, with a body naming the tied files — never a silent pick.

Replies are given as `reply` (a single reply) or `replies` (an ordered list). Each match on the fixture consumes the next reply; after the last, the last repeats.

Reply fields — at most one of `text`, `json`, or `events` per reply; `toolCalls` combines with `text` or `json`, text first:

| Field | Meaning |
| --- | --- |
| `text` | Assistant prose, streamed as several `response.output_text.delta` events wrapped in the spec-complete sequence (`response.created`, `output_item.added`, deltas, `output_item.done`, `response.completed`). Chunk boundaries are unspecified; tests must not assert them. |
| `json` | An object, serialized once and streamed as output-text deltas — for endpoints called with `text.format`. |
| `toolCalls` | A list of `{name, args, callId?}`; `callId` defaults to a deterministic generated id. Each call emits `output_item.added` with the name, `function_call_arguments.delta`, then `output_item.done` with the full item. |
| `error` | `{message, type, status?}`. With `status`: an immediate non-2xx JSON body `{error: {message, type}}`. Without: a 200 stream ending in `response.failed` carrying `{response: {error: {message, type}}}`. |
| `events` | A raw ordered list of `{event, data}` pairs sent verbatim — the escape hatch when no shorthand fits, reasoning items included. |
| `delayMs` | Wait before the first event. |
| `interEventMs` | Pause between events, for claims that watch text arrive incrementally. |
| `hold` | Emit the deltas, then keep the connection open without the closing events until the client disconnects — for abort-mid-stream claim L8 ([frontend-behavior-claims.md](../../../../frontend-behavior-claims.md)). |

### Embeddings

An embeddings request is a POST to `/embeddings` with body `{input: string[], model, dimensions}` (`nabu-frontend/app/lib/embeddings/client.ts:21-26`) and the same headers as LLM calls (`client.ts:39`), in batches of up to 512 inputs (`nabu-frontend/app/lib/embeddings/constants.ts:7,13-16`). The response is `{data: [{index, embedding}], usage: {total_tokens}}` (`client.ts:11-19`); the client reorders by `index` (`client.ts:28-29`) but the server emits in input order anyway.

The embeddings surface takes no fixtures: every well-formed request gets a deterministic answer. Each vector derives from its input string alone — hash-seeded, unit length, exactly `dimensions` wide — so the same string yields the same vector in any batch, on any call, across restarts; distinct strings yield distinct vectors. Determinism and exact width matter because vectors persist into companion files, and a changed `dimensions` value changing the stored width is precisely what claim E5 observes ([frontend-behavior-claims.md](../../../../frontend-behavior-claims.md)). `usage.total_tokens` carries any constant: the client types it but reads only `data` (`nabu-frontend/app/lib/embeddings/client.ts:16-19`).

A request missing `input`, `model`, or `dimensions` fails loud with a non-2xx and a body naming what was missing; the embeddings client surfaces the raw body as its error message (`nabu-frontend/app/lib/embeddings/client.ts:46-48`).

### Unmatched requests and the journal

An LLM request no fixture matches gets a 501 with body `{error: {message, type: "e2e_unmatched"}}`, the message naming the path and how many fixtures were consulted — the shape the frontend parses into its thrown error (`nabu-frontend/app/lib/agent/client/fetch.ts:41-51`), so the failure names itself in the UI and in test output. The request is journaled with `fixture` null. A POST whose body is not JSON gets the same loud non-2xx treatment, journaled with `body` null. There is no default answer.

Every request on both surfaces appends one journal entry:

| Field | Meaning |
| --- | --- |
| `seq` | Global arrival order across both surfaces, gapless from 1. |
| `path` | The request path as served — `/embeddings` entries are the embeddings surface, everything else the LLM one. |
| `projectId` | From `X-Project-ID`; how parallel tests keep to their own traffic. |
| `body` | The parsed request body, null when it was not JSON. |
| `fixture` | The matching fixture's filename, or null. |

One control endpoint lives under `/_e2e/` on both ports; every prompt path is a single bare segment (the table above), so a two-segment path under a leading-underscore prefix can never be shadowed by a prompt name. GET `/_e2e/journal` returns the entries as a JSON array, `?project=` narrowing to one `X-Project-ID`; it is reachable through the published proxy as `/llm/_e2e/journal`, since the proxy forwards any `/llm/*` path (`nabu-self-hosted/Caddyfile:42-44`).

> [!NOTE]
> The frontend's own LLM response cache can answer a repeated call before it reaches the journal; the [test-suite](test-suite.md) owns that fact and its mitigation.

## Prior art

Existing servers were checked before hand-rolling; each misses a load-bearing requirement:

- piyook/llm-mock — chat-completions and embeddings with fixture files in docker, but no Responses API surface.
- zerob13/mock-openai-api — Responses API in docker, but no embeddings endpoint and no body-matched fixtures.
- StacklokLabs/mockllm — a YAML prompt-to-response map, but no embeddings and no docker image.
- WireMock — mappings on disk with body matching in docker, but no true SSE, only a chunked-dribble approximation the framing contract above rules out.
- MSW — an in-process interceptor, not a standalone server a compose slot can point at.

## Tests

### Skeleton

This component carries two legs of the [walking skeleton](spec.md): boot, where the stack turns healthy only because both ports answer `/health` and the seeded corpus embeds against `/embeddings`, and the first chat turn, where the `/qual-coder` marker fixture streams the text the browser renders.

Given the container started with the skeleton fixture set — the standing boot fixtures ([test-suite](test-suite.md)) plus one `/qual-coder` fixture matching a planted marker — when the harness boots the stack and the test sends the marker message, then the fixture's text renders in the browser and GET `/_e2e/journal` lists the boot-time embeddings requests ahead of the `/qual-coder` entry, none unmatched.

### Contract cases

Riskiest first:

1. Unmatched fail-loud. Given loaded fixtures, when a POST arrives at an LLM path none matches, then the response is 501 with `{error: {message, type: "e2e_unmatched"}}` and the journal holds the entry with `fixture` null; and given two fixtures with equally many `contains` strings both matching, then the same loud failure names both files.
2. Invalid fixtures die at boot. Given a fixtures directory holding one file with an unknown key, a missing `endpoint`, or both `reply` and `replies`, when the container starts, then it exits nonzero naming the file and the field, and serves nothing.
3. Real-client SSE framing. Given a fixture at `/responses` with a text reply, when the official OpenAI client streams from the container as its base URL, then it yields the text and completes without a protocol error — the strongest available check that the framing is real Responses SSE rather than merely what the frontend's parser tolerates.
4. Tool-call framing. Given a `toolCalls` fixture, when the stream is read raw, then `output_item.added` announces the name, arguments arrive as `function_call_arguments.delta`, and `output_item.done` carries `{type: "function_call", call_id, name, arguments}` with `arguments` as a JSON string — the one event the frontend lands a call from (`nabu-frontend/app/lib/agent/client/parse.ts:153-163`).
5. Abort and slow streams. Given a reply with `interEventMs` and `hold`, when the client disconnects after the first delta, then the server releases the connection, the request stands journaled, and an immediately following request is answered normally.
6. Deterministic vectors. Given the same input string placed in two differently shaped batches with `dimensions` 64, when both responses land, then the two vectors are identical and 64 wide; a different string yields a different vector, and `dimensions` 128 yields a 128-wide one.
7. Journal under concurrency. Given many concurrent posts across both ports tagged with distinct `X-Project-ID` values, when the journal is read, then every request appears exactly once with unique gapless `seq`, and `?project=` returns exactly that project's entries.
8. Matcher precedence. Given two fixtures on one endpoint whose `contains` sets are subset and superset, when a request satisfies both, then the superset fixture answers and the journal names it.

### Isolation

These tests run the image alone: `docker run` with a fixtures directory mounted read-only, driven by plain HTTP from the test runner against ports 8081 and 8082. No compose stack, no proxy, no browser — the container's contract is provable at its two ports, and the stack only adds routing in front of them.
