import { test, expect, nabuQuery } from "../helpers/fixtures"
import {
  sendChat,
  toolNames,
  toolOutputs,
  agentEntries,
  type ToolOutput,
} from "../helpers/agent"

const REPLY_TIMEOUT = 30_000

interface ShellCommandResult {
  stdout: string
  stderr: string
  outcome: { type: string; exit_code: number }
}

interface ToolResultJson {
  status: string
  message?: string
  output: unknown
}

const parseResult = (out: ToolOutput | undefined): ToolResultJson => {
  if (!out) throw new Error("expected a function_call_output but found none")
  return JSON.parse(out.output) as ToolResultJson
}

const shellCommands = (out: ToolOutput | undefined): ShellCommandResult[] =>
  parseResult(out).output as ShellCommandResult[]

const calloutDoc = (id: string, title: string): string => `# ${title} Doc

Some prose around the block.

\`\`\`json-callout
{
	"id": "${id}",
	"type": "codebook-code",
	"title": "${title}",
	"content": "Block content",
	"color": "blue",
	"collapsed": false
}
\`\`\`
`

test("run_local_shell covers the read commands with pipes, chaining and quoting", { tag: ["@T1"] }, async ({ page, project }) => {
  await project.open(page)

  await sendChat(page, "Read the corpus E2E-T1-SHELL")
  await expect(page.getByText("T1-DONE")).toBeVisible({ timeout: REPLY_TIMEOUT })

  const entries = await agentEntries(project, "E2E-T1-SHELL")
  const cmds = shellCommands(
    toolOutputs(entries[entries.length - 1]).find((o) => o.name === "run_local_shell")
  )
  expect(cmds).toHaveLength(14)

  // grep -rn piped through head: line-numbered file:line output, max 3 lines
  expect(cmds[0].outcome.exit_code).toBe(0)
  expect(cmds[0].stdout).toMatch(/\.md:\d+:/)
  expect(cmds[0].stdout.split("\n").length).toBeLessThanOrEqual(3)

  // rg works and says it is an alias
  expect(cmds[1].stdout).toContain("visibility")
  expect(cmds[1].stdout).toContain("rg is alias for grep")

  // ls with -t/--show-date and --show-tags
  expect(cmds[2].outcome.exit_code).toBe(0)
  expect(cmds[2].stdout).toContain("interview-anna.md")
  expect(cmds[3].outcome.exit_code).toBe(0)
  expect(cmds[3].stdout).toContain("field-notes.md")

  // cat | wc -l
  expect(cmds[4].stdout.trim()).toMatch(/^\d+$/)

  // head / tail
  expect(cmds[5].stdout).toContain("# Interview with Anna")
  expect(cmds[6].outcome.exit_code).toBe(0)
  expect(cmds[6].stdout.split("\n").length).toBeLessThanOrEqual(2)

  // find by pattern
  const found = cmds[7].stdout.split("\n").sort()
  expect(found).toEqual(["interview-anna.md", "interview-bram.md"])

  // quoting keeps operators literal
  expect(cmds[8].stdout).toBe("quoted; not && operators")

  // && ; || chaining (true, echo participate; true contributes an empty line)
  expect(cmds[9].outcome.exit_code).toBe(0)
  expect(cmds[9].stdout.trim()).toBe("T1-CHAIN-AND")
  expect(cmds[10].stdout + cmds[10].stderr).toContain("T1-CHAIN-OR")
  expect(cmds[11].stdout).toBe("one\ntwo")

  // grep -i flag
  expect(cmds[12].outcome.exit_code).toBe(0)
  expect(cmds[12].stdout.toLowerCase()).toContain("office")

  // three-stage pipe: cat | sort -u | wc -l
  expect(cmds[13].stdout.trim()).toMatch(/^\d+$/)
})

test("redirects, substitution and builtins are rejected by name; writes are impossible", { tag: ["@T2"] }, async ({ page, project }) => {
  await project.open(page)

  await sendChat(page, "Try to write E2E-T2-NOBASH")
  await expect(page.getByText("T2-DONE")).toBeVisible({ timeout: REPLY_TIMEOUT })

  const entries = await agentEntries(project, "E2E-T2-NOBASH")
  const last = entries[entries.length - 1]
  const rejected = shellCommands(toolOutputs(last).find((o) => o.callId === "call-t2-reject"))
  expect(rejected).toHaveLength(4)

  const expectedTokens = ["'>'", "'$('", "'if'", "'<'"]
  rejected.forEach((cmd, i) => {
    expect(cmd.outcome.exit_code).not.toBe(0)
    // Not a parse failure: the error names what is unsupported and the alternative.
    expect(cmd.stderr).toContain("This is not bash.")
    expect(cmd.stderr).toContain(`${expectedTokens[i]} is not supported`)
    expect(cmd.stderr).toContain("Use only: cat, head, tail, ls, grep, find, wc, echo, sort")
  })

  // Nothing was written through the shell.
  const check = shellCommands(toolOutputs(last).find((o) => o.callId === "call-t2-check"))
  expect(check[0].stdout).not.toContain("t2-evil.txt")
  expect(check[1].stderr).toContain("t2-evil.txt: No such file")
})

test("block edits go through generated typed tools taking field operations", { tag: ["@T3"] }, async ({ page, project }) => {
  await project.seed("t3-doc.md", calloutDoc("callout-3t3aaaaa", "T3 Original Title"))
  await project.open(page)

  await sendChat(page, "Patch the callout E2E-T3-TYPED")
  await expect(page.getByText("T3-DONE")).toBeVisible({ timeout: REPLY_TIMEOUT })

  const entries = await agentEntries(project, "E2E-T3-TYPED")
  const chatTools = toolNames(entries[0])
  // patch_* and delete_* exist for every registered type…
  for (const short of ["attributes", "annotations", "callout", "settings", "chart"]) {
    expect(chatTools).toContain(`patch_${short}`)
    expect(chatTools).toContain(`delete_${short}`)
  }
  // …add_*/move_* only for the non-singletons.
  for (const short of ["callout", "chart"]) {
    expect(chatTools).toContain(`add_${short}`)
    expect(chatTools).toContain(`move_${short}`)
  }
  for (const short of ["attributes", "annotations", "settings"]) {
    expect(chatTools).not.toContain(`add_${short}`)
    expect(chatTools).not.toContain(`move_${short}`)
  }

  const patched = parseResult(
    toolOutputs(entries[entries.length - 1]).find((o) => o.name === "patch_callout")
  )
  expect(patched.status).toBe("ok")
  expect(String(patched.output)).toContain("t3-doc.md")

  // The field operation landed as a field change, visible in the projection.
  await expect
    .poll(async () => {
      const rows = (await nabuQuery(
        page,
        "select title from callouts where file = 't3-doc.md'"
      )) as { title: string }[]
      return rows[0]?.title
    }, { timeout: REPLY_TIMEOUT })
    .toBe("T3 Patched Title")
})

test("a mutating tool result is the unified diff of what actually changed", { tag: ["@T4"] }, async ({ page, project }) => {
  await project.seed("t4-doc.md", calloutDoc("callout-4t4aaaaa", "T4 Original Title"))
  await project.open(page)

  await sendChat(page, "Patch the callout E2E-T4-DIFF")
  await expect(page.getByText("T4-DONE")).toBeVisible({ timeout: REPLY_TIMEOUT })

  const entries = await agentEntries(project, "E2E-T4-DIFF")
  const patched = parseResult(
    toolOutputs(entries[entries.length - 1]).find((o) => o.name === "patch_callout")
  )
  expect(patched.status).toBe("ok")
  const output = String(patched.output)
  // The result must show the diff of what landed, not just echo the request.
  expect(output).toContain("@@")
  expect(output).toContain("T4 Original Title")
  expect(output).toContain("T4 Replaced Title")
})

test("fuzzy fields anchor to document prose; edits are anchored, not line-numbered", { tag: ["@T5"] }, async ({ page, project }) => {
  await project.seed(
    "t5-doc.md",
    "# T5 Doc\n\nAnna values the freedom to arrange her own schedule, and she guards it fiercely.\n"
  )
  await project.open(page)

  await sendChat(page, "Annotate and edit E2E-T5-FUZZY")
  await expect(page.getByText("T5-DONE")).toBeVisible({ timeout: REPLY_TIMEOUT })

  const entries = await agentEntries(project, "E2E-T5-FUZZY")
  const last = entries[entries.length - 1]

  const annotate = parseResult(toolOutputs(last).find((o) => o.callId === "call-t5-annotate"))
  expect(annotate.status).toBe("ok")

  // The lowercase quote was fuzzy-matched to the document's own casing.
  await expect
    .poll(async () => {
      const rows = (await nabuQuery(
        page,
        "select text from annotations where file = 't5-doc.md'"
      )) as { text: string }[]
      return rows[0]?.text ?? ""
    }, { timeout: REPLY_TIMEOUT })
    .toContain("Anna values the freedom to arrange her own schedule")

  // The edit anchor differed in case and punctuation, yet resolved.
  const edit = parseResult(toolOutputs(last).find((o) => o.callId === "call-t5-edit"))
  expect(edit.status).toBe("ok")
  expect(String(edit.output)).toContain("Edited t5-doc.md")
  const check = shellCommands(toolOutputs(last).find((o) => o.callId === "call-t5-check"))
  // grep -c prefixes the filename: "t5-doc.md:1"
  expect(check[0].stdout.trim()).toMatch(/(^|:)1$/)
})

test("file operations work; hidden files refuse except settings; generated files redirect", { tag: ["@T6"] }, async ({ page, project }) => {
  await project.seed("t6-doc.md", calloutDoc("callout-6t6aaaaa", "T6 Original"))
  await project.open(page)

  await sendChat(page, "Manage files E2E-T6-FILES")
  await expect(page.getByText("T6-DONE")).toBeVisible({ timeout: REPLY_TIMEOUT })

  const entries = await agentEntries(project, "E2E-T6-FILES")
  const last = entries[entries.length - 1]
  const outs = toolOutputs(last)

  const creates = outs.filter((o) => o.name === "create_file").map(parseResult)
  const note = creates.find((r) => String(r.output).includes("t6-note.md"))
  expect(note?.status).toBe("ok")
  const hidden = creates.find((r) => String(r.output).includes("secret.hidden.md"))
  expect(hidden?.status).toBe("error")
  expect(String(hidden?.output)).toContain("hidden file, cannot be modified by the assistant")

  for (const name of ["copy_file", "rename_file", "remove_file"]) {
    expect(parseResult(outs.find((o) => o.name === name)).status, `${name} should succeed`).toBe(
      "ok"
    )
  }

  // The settings file is the one hidden file the assistant may touch.
  const settings = parseResult(outs.find((o) => o.name === "patch_settings"))
  expect(settings.status).toBe("ok")
  expect(String(settings.output)).toContain("settings.hidden.md")

  // The write aimed at the generated companion landed on its source document.
  const redirected = parseResult(outs.find((o) => o.name === "patch_callout"))
  expect(redirected.status).toBe("ok")
  const check = shellCommands(outs.find((o) => o.callId === "call-t6-check"))
  expect(check[0].stdout).toContain("t6-renamed.md")
  expect(check[0].stdout).not.toContain("t6-note.md")
  expect(check[0].stdout).not.toContain("t6-copy.md")
  expect(check[1].stdout).toContain("T6-REDIRECT-TITLE")

  await expect
    .poll(async () => {
      const rows = (await nabuQuery(
        page,
        "select title from callouts where file = 't6-doc.md'"
      )) as { title: string }[]
      return rows[0]?.title
    }, { timeout: REPLY_TIMEOUT })
    .toBe("T6-REDIRECT-TITLE")
})

test("query runs SQL on projected tables and search returns readable file paths", { tag: ["@T7"] }, async ({ page, project }) => {
  await project.seed("t7-doc.md", calloutDoc("callout-7t7aaaaa", "T7"))
  await project.open(page)

  await sendChat(page, "Look things up E2E-T7-QUERY")
  await expect(page.getByText("T7-DONE")).toBeVisible({ timeout: 60_000 })

  const entries = await agentEntries(project, "E2E-T7-QUERY")
  const last = entries[entries.length - 1]
  const outs = toolOutputs(last)

  const query = parseResult(outs.find((o) => o.name === "query"))
  expect(query.status).toBe("ok")
  expect(String(query.output)).toContain("t7-doc.md")

  const search = parseResult(outs.find((o) => o.name === "search"))
  expect(search.status).toBe("ok")
  expect(String(search.output)).toContain("file://search-")
  expect(String(search.output)).toContain("t7-doc.md")

  // The path both tools returned is readable through the shell.
  const read = shellCommands(outs.find((o) => o.callId === "call-t7-read"))
  expect(read[0].outcome.exit_code).toBe(0)
  expect(read[0].stdout).toContain("# T7 Doc")
})

test("ask puts the question to the user and suspends until answered", { tag: ["@T8"] }, async ({ page, project }) => {
  await project.open(page)

  await sendChat(page, "Ask me something E2E-T8-ASK")
  await expect(page.getByText("E2E-T8 which way should we go?")).toBeVisible({
    timeout: REPLY_TIMEOUT,
  })
  await expect(page.getByText("T8 Option Alpha")).toBeVisible()
  await expect(page.locator('textarea[name="chat-message"]')).toHaveAttribute(
    "placeholder",
    "Or type your own answer..."
  )

  // Suspended: no follow-up request leaves while the question stands.
  await page.waitForTimeout(1500)
  expect((await agentEntries(project, "E2E-T8-ASK")).length).toBe(1)

  await page.getByText("T8 Option Alpha").click()
  await expect(page.getByText("T8-DONE")).toBeVisible({ timeout: REPLY_TIMEOUT })

  const entries = await agentEntries(project, "E2E-T8-ASK")
  expect(entries.length).toBe(2)
  const askOut = toolOutputs(entries[1]).find((o) => o.name === "ask")
  expect(askOut?.output).toContain("T8-EXPECTED-ALPHA path taken")
})

test("arguments failing the Zod schema never reach the handler", { tag: ["@T9"] }, async ({ page, project }) => {
  await project.open(page)

  await sendChat(page, "Send broken calls E2E-T9-ZOD")
  await expect(page.getByText("T9-DONE")).toBeVisible({ timeout: REPLY_TIMEOUT })

  const entries = await agentEntries(project, "E2E-T9-ZOD")
  const last = entries[entries.length - 1]
  const outs = toolOutputs(last)

  const create = outs.find((o) => o.name === "create_file")
  expect(create?.output).toContain("Invalid arguments")
  expect(create?.output).toContain("content")

  const query = outs.find((o) => o.name === "query")
  expect(query?.output).toContain("Invalid arguments")
  expect(query?.output).toContain("sql")

  // The create_file handler never ran: the file does not exist.
  const check = shellCommands(outs.find((o) => o.callId === "call-t9-check"))
  expect(check[0].stdout).not.toContain("t9-invalid.md")
})
