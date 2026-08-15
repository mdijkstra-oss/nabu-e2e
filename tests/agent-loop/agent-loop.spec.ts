import { test, expect } from "../helpers/fixtures"
import {
  sendChat,
  chatButton,
  entryText,
  toolNames,
  toolOutputs,
  agentEntries,
  waitForAgentEntries,
} from "../helpers/agent"

const REPLY_TIMEOUT = 30_000

const MUTATING_PREFIXES = ["patch_", "add_", "move_", "delete_"]
const MUTATING_FILE_TOOLS = ["edit_file", "create_file", "copy_file", "rename_file", "remove_file"]

const isMutatingTool = (name: string): boolean =>
  MUTATING_PREFIXES.some((p) => name.startsWith(p)) || MUTATING_FILE_TOOLS.includes(name)

test("state derives from the transcript; replaying the chain reproduces the mode", { tag: ["@stubbed"] }, async ({ page, project }) => {
  await project.open(page)

  await sendChat(page, "Question one E2E-L1-CHAIN")
  await expect(page.getByText("L1-PLAN-REPLY-ONE")).toBeVisible({ timeout: REPLY_TIMEOUT })
  await sendChat(page, "Question two E2E-L1-CHAIN-SECOND")
  await expect(page.getByText("L1-PLAN-REPLY-TWO")).toBeVisible({ timeout: REPLY_TIMEOUT })

  const entries = await agentEntries(project, "E2E-L1-CHAIN")
  const planning = entries.filter((e) => e.path === "/qual-coder.planning")
  // Both turns after start_planning derived plan mode purely from the chain:
  // the second user message carried no new trigger, yet still routed to plan.
  expect(planning.length).toBe(2)

  const [first, second] = planning
  const firstText = entryText(first)
  const secondText = entryText(second)
  // The trigger lives in the transcript itself (start_planning call + result)
  // and is replayed into every later request.
  expect(firstText).toContain("E2E-L1 plan the analysis")
  expect(secondText).toContain("E2E-L1 plan the analysis")
  // The second request replays everything the first state was derived from.
  expect(secondText).toContain("Question one E2E-L1-CHAIN")
  expect(secondText).toContain("L1-PLAN-REPLY-ONE")
  expect(secondText).toContain("Question two E2E-L1-CHAIN-SECOND")
})

test("chat mode can read, search, query, edit, start planning; cancel returns to chat", { tag: ["@stubbed"] }, async ({ page, project }) => {
  await project.open(page)

  await sendChat(page, "Please plan this E2E-L2-MODE")
  await expect(page.getByText("L2-BACK-IN-CHAT-OK")).toBeVisible({ timeout: REPLY_TIMEOUT })

  const entries = await agentEntries(project, "E2E-L2-MODE")
  const chatReqs = entries.filter((e) => e.path === "/qual-coder")
  const planReqs = entries.filter((e) => e.path === "/qual-coder.planning")
  expect(chatReqs.length).toBe(2)
  expect(planReqs.length).toBe(1)

  const chatTools = toolNames(chatReqs[0])
  for (const name of [
    "run_local_shell",
    "search",
    "query",
    "patch_callout",
    "add_callout",
    "edit_file",
    "create_file",
    "copy_file",
    "rename_file",
    "remove_file",
    "start_planning",
  ]) {
    expect(chatTools, `chat request should offer ${name}`).toContain(name)
  }

  // start_planning switched to plan, cancel switched back to chat.
  expect(planReqs[0].seq).toBeGreaterThan(chatReqs[0].seq)
  expect(chatReqs[1].seq).toBeGreaterThan(planReqs[0].seq)
  const cancelOut = toolOutputs(chatReqs[1]).find((o) => o.name === "cancel")
  expect(cancelOut?.output).toContain("Cancelled: E2E-L2 cancel back to chat")
})

test("plan mode carries no mutating tools; submit_plan switches to exec", { tag: ["@stubbed"] }, async ({ page, project }) => {
  await project.open(page)

  await sendChat(page, "Please plan this E2E-L3-PLANTOOLS")
  await expect(page.getByText("L3-EXEC-REACHED")).toBeVisible({ timeout: REPLY_TIMEOUT })

  const entries = await agentEntries(project, "E2E-L3-PLANTOOLS")
  const planReq = entries.find((e) => e.path === "/qual-coder.planning")
  const execReq = entries.find((e) => e.path === "/qual-coder.execution")
  expect(planReq).toBeTruthy()
  expect(execReq).toBeTruthy()

  const planTools = toolNames(planReq!).sort()
  expect(planTools.filter(isMutatingTool)).toEqual([])
  expect(planTools).toEqual(["ask", "cancel", "query", "run_local_shell", "search", "submit_plan"])

  expect(execReq!.seq).toBeGreaterThan(planReq!.seq)
})

test("exec mode has everything chat has except start_planning, plus complete_step", { tag: ["@stubbed"] }, async ({ page, project }) => {
  await project.open(page)

  await sendChat(page, "Please execute this E2E-L4A-TOOLS")
  await expect(page.getByText("L4A-EXEC-DONE")).toBeVisible({ timeout: REPLY_TIMEOUT })

  const entries = await agentEntries(project, "E2E-L4A-TOOLS")
  const chatReq = entries.find((e) => e.path === "/qual-coder")
  const execReq = entries.find((e) => e.path === "/qual-coder.execution")
  expect(chatReq).toBeTruthy()
  expect(execReq).toBeTruthy()

  const chatTools = toolNames(chatReq!)
  const execTools = toolNames(execReq!)
  expect(execTools).toContain("complete_step")
  // Exec is already running a plan, so starting one is the single chat tool
  // deliberately withheld there.
  const missingFromExec = chatTools.filter((t) => !execTools.includes(t))
  expect(missingFromExec, "only start_planning is withheld in exec").toEqual(["start_planning"])
})

test("completing the last step retires the plan and falls back to chat", { tag: ["@stubbed"] }, async ({ page, project }) => {
  await project.open(page)

  await sendChat(page, "Please execute this E2E-L4B-RETIRE")
  await expect(page.getByText("L4B-BACK-IN-CHAT")).toBeVisible({ timeout: REPLY_TIMEOUT })

  const entries = await agentEntries(project, "E2E-L4B-RETIRE")
  const execReq = entries.find((e) => e.path === "/qual-coder.execution")
  const chatReqs = entries.filter((e) => e.path === "/qual-coder")
  expect(execReq).toBeTruthy()
  // After complete_step on the only step, the follow-up went to chat by itself.
  expect(chatReqs.length).toBe(2)
  const final = chatReqs[1]
  expect(final.seq).toBeGreaterThan(execReq!.seq)
  const stepOut = toolOutputs(final).find((o) => o.name === "complete_step")
  expect(stepOut?.output).toContain("Plan complete.")
  // Nothing routed to plan/exec endpoints after the plan retired.
  expect(entries.filter((e) => e.seq > final.seq && e.path !== "/qual-coder")).toEqual([])
})

test("wrong-mode tools and unknown tools get distinct errors", { tag: ["@stubbed"] }, async ({ page, project }) => {
  await project.open(page)

  await sendChat(page, "Please plan this E2E-L5-ERRORS")
  await expect(page.getByText("L5-DONE")).toBeVisible({ timeout: REPLY_TIMEOUT })

  const entries = await agentEntries(project, "E2E-L5-ERRORS")
  const planReqs = entries.filter((e) => e.path === "/qual-coder.planning")
  expect(planReqs.length).toBeGreaterThanOrEqual(2)
  const outs = toolOutputs(planReqs[planReqs.length - 1])

  // outputs are JSON-stringified tool results; parse before matching quotes
  const wrongMode = JSON.parse(outs.find((o) => o.name === "edit_file")!.output) as {
    status: string
    output: string
  }
  expect(wrongMode.status).toBe("error")
  expect(wrongMode.output).toContain('Tool "edit_file" is not available in plan mode.')

  const unknown = JSON.parse(outs.find((o) => o.name === "make_coffee")!.output) as {
    status: string
    output: string
  }
  expect(unknown.status).toBe("error")
  expect(unknown.output).toContain('Tool "make_coffee" does not exist.')
  expect(unknown.output).toContain(
    "Available tools: ask, cancel, query, run_local_shell, search, submit_plan"
  )
})

test("dead entity ids reject the message and re-ask the model", { tag: ["@stubbed"] }, async ({ page, project }) => {
  await project.open(page)

  await sendChat(page, "Summarize E2E-L6-REJECT")
  await expect(page.getByText("L6-GOOD-ANSWER")).toBeVisible({ timeout: REPLY_TIMEOUT })
  // The first answer cited callout-3kf9m2qp, which resolves to nothing: never shown.
  await expect(page.getByText("L6-BAD-ANSWER")).toHaveCount(0)

  const entries = await agentEntries(project, "E2E-L6-REJECT")
  expect(entries.length).toBe(2)
  const reask = entryText(entries[1])
  expect(reask).toContain("these entity IDs do not exist: callout-3kf9m2qp")
  expect(reask).toContain("DO NOT restate")
})

test("rejections cap at three, then the answer is let through and flagged", { tag: ["@stubbed"] }, async ({ page, project }) => {
  await project.open(page)

  await sendChat(page, "Summarize E2E-L6-CAP")
  await waitForAgentEntries(project, "E2E-L6-CAP", 4, 60_000)
  await page.waitForTimeout(2500)
  // Initial ask plus exactly three re-asks; the cap stops a fifth request.
  expect((await agentEntries(project, "E2E-L6-CAP")).length).toBe(4)
  // After three consecutive rejections the next answer must be let through,
  // visibly flagged so the user can judge it.
  await expect(page.getByText("L6-CAP-BAD-ANSWER")).toBeVisible({ timeout: 5_000 })
  await expect(page.getByText("references entities that do not exist")).toBeVisible()
})

test("complete_step out of order is rejected against the derived plan state", { tag: ["@stubbed"] }, async ({ page, project }) => {
  await project.open(page)

  await sendChat(page, "Please run the plan E2E-L7-GUARD")
  await expect(page.getByText("L7-DONE")).toBeVisible({ timeout: REPLY_TIMEOUT })

  const entries = await agentEntries(project, "E2E-L7-GUARD")
  const outsByCall = new Map<string, string>()
  for (const e of entries) {
    for (const o of toolOutputs(e)) {
      if (o.name === "complete_step") outsByCall.set(o.callId, o.output)
    }
  }
  const outputs = [...outsByCall.values()]
  // The in-plan completion succeeded; the one after the plan finished was
  // rejected against the derived state, not against a mode flag.
  expect(outputs.some((o) => o.includes("Plan complete."))).toBe(true)
  expect(outputs.some((o) => o.includes("Plan is already complete — all steps are done."))).toBe(
    true
  )
})

test("aborting mid-stream keeps completed blocks and resumes on the next message", { tag: ["@stubbed"] }, async ({ page, project }) => {
  await project.open(page)

  await sendChat(page, "Warm up E2E-L8-ABORT")
  await expect(page.getByText("L8-FIRST-REPLY-DONE")).toBeVisible({ timeout: REPLY_TIMEOUT })

  await sendChat(page, "Go again E2E-L8-ABORT-GO2")
  await expect(page.getByText("L8-SECOND-STREAM")).toBeVisible({ timeout: 20_000 })
  await chatButton(page).click()

  // The in-flight draft is discarded; completed blocks stay.
  await expect(page.getByText("L8-SECOND-STREAM")).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByText("L8-FIRST-REPLY-DONE")).toBeVisible()

  // The loop returned to waiting: the aborted request is the only one carrying
  // the second message, and the pending tool call never executed.
  await page.waitForTimeout(2000)
  expect((await agentEntries(project, "E2E-L8-ABORT-GO2")).length).toBe(1)
  const all = await agentEntries(project, "E2E-L8-ABORT")
  for (const e of all) {
    for (const o of toolOutputs(e)) {
      expect(o.output).not.toContain("L8-NEVER-RUN")
    }
  }

  await sendChat(page, "Resume E2E-L8-ABORT-GO3")
  await expect(page.getByText("L8-THIRD-REPLY-OK")).toBeVisible({ timeout: REPLY_TIMEOUT })
  const resumed = (await agentEntries(project, "E2E-L8-ABORT-GO3"))[0]
  const text = entryText(resumed)
  expect(text).toContain("L8-FIRST-REPLY-DONE")
  expect(text).toContain("E2E-L8-ABORT-GO2")
  expect(text).not.toContain("L8-SECOND-STREAM")
})

test("shell-error nudge fires that turn; with nothing to say and no tool call the run ends", { tag: ["@stubbed"] }, async ({ page, project }) => {
  await project.open(page)

  await sendChat(page, "Try a write E2E-L9-NUDGE")
  await expect(page.getByText("L9-DONE")).toBeVisible({ timeout: REPLY_TIMEOUT })

  const entries = await agentEntries(project, "E2E-L9-NUDGE")
  expect(entries.length).toBe(2)
  expect(entryText(entries[1])).toContain(
    "**Shell error** - Review the run_local_shell tool definition"
  )

  // After the plain text reply no nudge had anything to add and no tool was
  // called: the run ends by itself, without further requests.
  await page.waitForTimeout(2500)
  expect((await agentEntries(project, "E2E-L9-NUDGE")).length).toBe(2)
})
