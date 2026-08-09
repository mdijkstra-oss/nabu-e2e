import { expect, test } from "../helpers/fixtures"
import {
  ADJUDICATE,
  FILE_HYDE,
  VOTER_ONE,
  VOTER_TWO,
  calloutBlock,
  countMatches,
  expectNoUnmatchedLlmCalls,
  pollAnnotations,
  requestText,
  sendChat,
  waitForCorpus,
} from "../helpers/consensus"

// Every target document opens with three plain-English sentences so language
// detection (first 200 chars of the chunk) never trips over marker words.

const C1_DOC = [
  "The council adopted the zephyrblue directive after a long open debate.",
  "Members praised the zephyrblue directive for its careful and narrow scope.",
  "Critics still called the zephyrblue directive a modest first step forward.",
  "The committee reviewed the schedule for the coming quarter without any fuss.",
  "Several members asked for clearer minutes from the previous public session.",
  "The treasurer summarised the accounts and noted a small surplus this year.",
  "A short recess was taken while the projector was moved to the other wall.",
  "Two visitors introduced themselves and thanked the board for its welcome.",
  "The secretary read the correspondence received since the previous meeting.",
  "A motion to extend the coffee budget was carried without much discussion.",
  "The chair reminded everyone about the deadline for the annual submissions.",
  "Somebody proposed moving the summer meeting to the larger community hall.",
  "The gardening group reported steady progress on the shared vegetable beds.",
  "A brief update followed on the repairs to the roof above the north stairs.",
  "The meeting closed with a reminder about the volunteer rota for the fair.",
  "The appendix that follows records gorseplum catering costs for the retreat.",
  "Nobody expects the gorseplum appendix to be read during ordinary meetings.",
].join("\n")

const C1_FRAMEWORK = [
  "# Analysis protocol E2E-C1-FRAMEWORK",
  "Treat hedged phrasing as evidence only when paired with a concrete commitment.",
  "Judge each passage on its own merits and ignore document titles.",
].join("\n")

const C1_CODEBOOK = [
  "# Zephyr codebook",
  calloutBlock(
    "callout-1c1alpha",
    "Zephyrblue endorsement",
    "E2E-C1-DIM-ALPHA Passages where a speaker endorses the zephyrblue directive."
  ),
  calloutBlock(
    "callout-1c1beta0",
    "Zephyrblue criticism",
    "E2E-C1-DIM-BETA Passages where a speaker criticises the zephyrblue directive."
  ),
].join("\n\n")

test(
  "run takes framework, dimensions and target; candidates cascade per dimension, cut to the target",
  { tag: ["@C1"] },
  async ({ page, project }) => {
    await project.seed("c1-target.md", C1_DOC)
    await project.seed("c1-framework.md", C1_FRAMEWORK)
    await project.seed("c1-codebook.md", C1_CODEBOOK)
    await project.open(page)
    await waitForCorpus(page, "c1-target.md")

    await sendChat(page, "Run the zephyr coding pass over the opening lines. E2E-C1-RUN")
    await expect(page.getByText("E2E-C1-DONE")).toBeVisible({ timeout: 60_000 })

    const journal = await project.journal()
    expectNoUnmatchedLlmCalls(journal)

    // The cascade runs once per dimension, against that dimension's own definition text.
    const hyde = journal.filter((e) => e.path === FILE_HYDE)
    const alphaHyde = hyde.filter((e) => requestText(e).includes("E2E-C1-DIM-ALPHA"))
    const betaHyde = hyde.filter((e) => requestText(e).includes("E2E-C1-DIM-BETA"))
    expect(alphaHyde.length).toBeGreaterThan(0)
    expect(betaHyde.length).toBeGreaterThan(0)
    for (const e of alphaHyde) expect(requestText(e)).not.toContain("E2E-C1-DIM-BETA")
    for (const e of betaHyde) expect(requestText(e)).not.toContain("E2E-C1-DIM-ALPHA")

    // The framework rides along as common context on every evaluation.
    const voterOne = journal.filter((e) => e.path === VOTER_ONE)
    expect(voterOne.length).toBeGreaterThan(0)
    for (const e of voterOne) {
      const text = requestText(e)
      expect(text).toContain("E2E-C1-FRAMEWORK")
      expect(text).toContain("<marked>")
    }
    const voterText = voterOne.map(requestText).join("\n")
    expect(voterText).toContain("zephyrblue")
    expect(voterText).toContain('<analysis id="callout-1c1alpha">')
    expect(voterText).toContain('<analysis id="callout-1c1beta0">')

    // Candidates are cut to the target's line range before any model judges them:
    // the gorseplum appendix sits outside lines 1-3 and never reaches the
    // candidate-judging endpoints.
    const judging = journal.filter((e) =>
      ["/semantic-filter", VOTER_ONE, VOTER_TWO, ADJUDICATE].includes(e.path)
    )
    expect(judging.length).toBeGreaterThan(0)
    for (const e of judging) expect(requestText(e)).not.toContain("gorseplum")
  }
)

const C2_DOC = [
  "The delivery team met briefly on Monday to review the sprint board together.",
  "Most of the planned work items were already moving through the review lane.",
  "The facilitator kept the meeting short and shared the notes afterwards.",
  ...Array.from({ length: 25 }, (_, i) => {
    const nn = String(i + 1).padStart(2, "0")
    return `Flumewick item ${nn} ran fine.`
  }),
].join("\n")

const C2_CODEBOOK = [
  "# Flumewick codebook",
  calloutBlock("callout-1c2alpha", "Alpha flow", "E2E-C2-DIM-ALPHA Flumewick items that ran fine."),
  calloutBlock("callout-1c2beta0", "Beta flow", "E2E-C2-DIM-BETA Flumewick items reviewed on Monday."),
  calloutBlock("callout-1c2gamma", "Gamma flow", "E2E-C2-DIM-GAMMA Flumewick items in the review lane."),
  calloutBlock("callout-1c2delta", "Delta flow", "E2E-C2-DIM-DELTA Flumewick items noted afterwards."),
].join("\n\n")

test(
  "spans are judged in context, ~20 per call, at most 3 dimensions mixed",
  { tag: ["@C2"] },
  async ({ page, project }) => {
    await project.seed("c2-notes.md", C2_DOC)
    await project.seed("c2-codebook.md", C2_CODEBOOK)
    await project.open(page)
    await waitForCorpus(page, "c2-notes.md")

    await sendChat(page, "Run the flumewick coding pass over the notes. E2E-C2-RUN")
    await expect(page.getByText("E2E-C2-DONE")).toBeVisible({ timeout: 60_000 })

    const journal = await project.journal()
    expectNoUnmatchedLlmCalls(journal)

    // 25 alpha spans + 1 span for each of beta/gamma/delta must batch as
    // [20 alpha] [5 alpha] [beta+gamma+delta].
    const voterOne = journal.filter((e) => e.path === VOTER_ONE)
    const texts = voterOne.map(requestText)
    const targetCounts = texts.map((t) => countMatches(t, /<target id="/g)).sort((a, b) => a - b)
    expect(targetCounts).toEqual([3, 5, 20])

    for (const t of texts) {
      expect(countMatches(t, /<analysis id="/g)).toBeLessThanOrEqual(3)
    }

    const mixed = texts.find((t) => countMatches(t, /<target id="/g) === 3)!
    for (const code of ["callout-1c2beta0", "callout-1c2gamma", "callout-1c2delta"]) {
      expect(mixed).toContain(`<analysis id="${code}">`)
    }

    const big = texts.find((t) => countMatches(t, /<target id="/g) === 20)!
    expect(countMatches(big, /code="callout-1c2alpha"/g)).toBe(20)

    // Each candidate arrives wrapped in its surrounding sentences.
    expect(big).toMatch(
      /Flumewick item 11 ran fine\.[\s\S]{0,400}<marked>Flumewick item 12 ran fine\.<\/marked>[\s\S]{0,400}Flumewick item 13 ran fine\./
    )
  }
)

const C3_DOC = [
  "The morning shift at the clinic began quietly with coffee and paperwork.",
  "Most patients arrived early and waited patiently near the front desk.",
  "Staff moved between the rooms and kept the whole corridor calm and tidy.",
  "The nurse lorniva sat down and listened to every worry the patient raised.",
  "The clerk drathmel waved the visitor away while staring at the screen.",
  "The cafeteria sopwill menu offered three soups and one stale bread roll.",
].join("\n")

const C3_CODEBOOK = [
  "# Clinic codebook",
  calloutBlock(
    "callout-1c3empat",
    "Empathy moments",
    "E2E-C3-DIM Moments where staff show empathy toward patients or visitors."
  ),
].join("\n\n")

test(
  "voter agreement is the verdict; disagreement escalates to an adjudicator that sees both reasons",
  { tag: ["@C3"] },
  async ({ page, project }) => {
    await project.seed("c3-visits.md", C3_DOC)
    await project.seed("c3-codebook.md", C3_CODEBOOK)
    await project.open(page)
    await waitForCorpus(page, "c3-visits.md")

    await sendChat(page, "Run the empathy coding pass over the visit notes. E2E-C3-RUN")
    await expect(page.getByText("E2E-C3-DONE")).toBeVisible({ timeout: 60_000 })

    const journal = await project.journal()
    expectNoUnmatchedLlmCalls(journal)

    // Only the split span escalates, and the adjudicator sees both arguments.
    const adjud = journal.filter((e) => e.path === ADJUDICATE)
    expect(adjud.length).toBe(1)
    const adjudText = requestText(adjud[0])
    expect(adjudText).toContain("drathmel")
    expect(adjudText).toContain("<keep-case>E2E-C3-SPLIT-KEEPCASE")
    expect(adjudText).toContain("<remove-case>E2E-C3-SPLIT-REMOVECASE")
    // The agreed spans appear at most as surrounding context, never as
    // contested candidates of their own.
    expect(countMatches(adjudText, /<target id="/g)).toBe(1)
    expect(adjudText).not.toMatch(/<marked>[^<]*lorniva/)
    expect(adjudText).not.toMatch(/<marked>[^<]*sopwill/)

    // Agreement settled the other two spans directly: agree-keep is annotated,
    // agree-remove is gone.
    const annotations = await pollAnnotations(project.id, "c3-visits.md", 2)
    const textsJoined = annotations.map((a) => a.text).join("\n")
    expect(textsJoined).toContain("lorniva")
    expect(textsJoined).toContain("drathmel")
    expect(textsJoined).not.toContain("sopwill")
  }
)

const C4_DOC = [
  "The town hall meeting ran longer than planned on the first evening.",
  "Residents lined up at the microphone to ask about the yearly charges.",
  "The clerk noted every question carefully in the public record book.",
  "The mayor said the quorvane tax was fair beyond any reasonable doubt.",
  "The mayor said the melbrook levy was fair beyond any reasonable doubt.",
  "The mayor said the tarnwisp fee was fair beyond any reasonable doubt.",
].join("\n")

const C4_CODEBOOK = [
  "# Fairness codebook",
  calloutBlock(
    "callout-1c4fairn",
    "Fairness claims",
    "E2E-C4-DIM Statements where a speaker asserts that a charge is fair."
  ),
].join("\n\n")

test(
  "adjudicator outcomes: reject drops, keep clears the objection, inconsistent keeps it as a flag",
  { tag: ["@C4"] },
  async ({ page, project }) => {
    await project.seed("c4-remarks.md", C4_DOC)
    await project.seed("c4-codebook.md", C4_CODEBOOK)
    await project.open(page)
    await waitForCorpus(page, "c4-remarks.md")

    await sendChat(page, "Run the fairness coding pass over the remarks. E2E-C4-RUN")
    await expect(page.getByText("E2E-C4-DONE")).toBeVisible({ timeout: 60_000 })

    const journal = await project.journal()
    expectNoUnmatchedLlmCalls(journal)

    const annotations = await pollAnnotations(project.id, "c4-remarks.md", 2)
    expect(annotations.length).toBe(2)

    // reject: span dropped.
    expect(annotations.map((a) => a.text).join("\n")).not.toContain("quorvane")

    // keep: span kept, the remover's objection cleared.
    const kept = annotations.find((a) => a.text.includes("melbrook"))
    expect(kept).toBeDefined()
    expect(kept!.vote?.review).toBeUndefined()

    // inconsistent: span kept, the objection attached as an ambiguity flag.
    const flagged = annotations.find((a) => a.text.includes("tarnwisp"))
    expect(flagged).toBeDefined()
    expect(flagged!.vote?.review).toBe("E2E-C4-ADJ-FLAG the definition is ambiguous here")
  }
)

const C5_DOC = [
  "The rain finally stopped a little before six in the evening yesterday.",
  "I took the long path home instead of waiting around for the crowded bus.",
  "The fields past the mill were empty and the light was soft and low.",
  "I felt much calmer after walking past the glimfern hedge by the river.",
].join("\n")

const C5_CODEBOOK = [
  "# Diary codebook",
  calloutBlock("callout-1c5moody", "Mood statements", "E2E-C5-DIM Passages describing the writer's mood."),
].join("\n\n")

test(
  "a surviving span is written back as an annotation carrying the keeper's reason",
  { tag: ["@C5"] },
  async ({ page, project }) => {
    await project.seed("c5-diary.md", C5_DOC)
    await project.seed("c5-codebook.md", C5_CODEBOOK)
    await project.open(page)
    await waitForCorpus(page, "c5-diary.md")

    await sendChat(page, "Run the mood coding pass over the diary. E2E-C5-RUN")
    await expect(page.getByText("E2E-C5-DONE")).toBeVisible({ timeout: 60_000 })

    const journal = await project.journal()
    expectNoUnmatchedLlmCalls(journal)

    // The annotation lives in the document itself, on disk.
    const annotations = await pollAnnotations(project.id, "c5-diary.md", 1)
    const mood = annotations.find((a) => a.text.includes("glimfern"))
    expect(mood).toBeDefined()
    expect(mood!.code).toBe("callout-1c5moody")
    expect(mood!.reason).toBe("E2E-C5-JUSTIFICATION calm mood shown")
  }
)

const C6_DOC = [
  "The park office opened at eight and the kettle went on straight away.",
  "A steady stream of walkers signed the visitor book through the morning.",
  "The weather stayed dry and the car park never quite filled up.",
  "The warden bellmarsh spoke gently with every hiker at the northern gate.",
  "The ranger cindervale nodded once and went back to the radio logbook.",
].join("\n")

const C6_CODEBOOK = [
  "# Field codebook",
  calloutBlock(
    "callout-1c6warmt",
    "Warmth toward visitors",
    "E2E-C6-DIM Moments where staff act warmly toward visitors."
  ),
].join("\n\n")

test(
  "a finished run reports per dimension how often each slot voted keep and how many contested spans ended flagged",
  { tag: ["@C6"] },
  async ({ page, project }) => {
    const consoleLines: string[] = []
    page.on("console", (msg) => consoleLines.push(msg.text()))

    await project.seed("c6-field.md", C6_DOC)
    await project.seed("c6-codebook.md", C6_CODEBOOK)
    await project.open(page)
    await waitForCorpus(page, "c6-field.md")

    await sendChat(page, "Run the warmth coding pass over the field notes. E2E-C6-RUN")
    await expect(page.getByText("E2E-C6-DONE")).toBeVisible({ timeout: 60_000 })

    const journal = await project.journal()
    expectNoUnmatchedLlmCalls(journal)

    // Scripted votes: voter-one keeps both spans (m0:2), voter-two keeps one
    // (m1:1); the contested span ends flagged by the adjudicator (a:1).
    await expect
      .poll(() =>
        consoleLines.find((l) => l.includes("[deep-analysis]") && l.includes("callout-1c6warmt"))
      )
      .toBeDefined()
    const report = consoleLines.find(
      (l) => l.includes("[deep-analysis]") && l.includes("callout-1c6warmt")
    )!
    expect(report).toMatch(/callout-1c6warmt\s+m0:2 m1:1\s+k:0 r:0 a:1/)
  }
)

const C7_DOC = [
  "The valley trail reopened last spring after two seasons of slow repairs.",
  "Walkers now follow the river for a mile before the path climbs the ridge.",
  "Local carters still prefer the old crossing over the newer concrete span.",
  "The old harrowpine bridge still carries the morning cart traffic safely.",
].join("\n")

const C7_CODEBOOK = [
  "# Trail codebook",
  calloutBlock(
    "callout-1c7good0",
    "Bridge passages",
    "E2E-C7-DIM-GOOD Passages about the harrowpine bridge."
  ),
  calloutBlock(
    "callout-1c7bad00",
    "Ferry passages",
    "E2E-C7-DIM-BAD Passages about the western ferry service."
  ),
].join("\n\n")

test(
  "a failed retrieval branch is reported as an error alongside results, not a failed run",
  { tag: ["@C7"] },
  async ({ page, project }) => {
    await project.seed("c7-trail.md", C7_DOC)
    await project.seed("c7-codebook.md", C7_CODEBOOK)
    await project.open(page)
    await waitForCorpus(page, "c7-trail.md")

    await sendChat(page, "Run the trail coding pass over the notes. E2E-C7-RUN")
    await expect(page.getByText("E2E-C7-DONE")).toBeVisible({ timeout: 60_000 })

    // The healthy branch still delivered: its span is annotated in the document.
    const annotations = await pollAnnotations(project.id, "c7-trail.md", 1)
    expect(annotations.map((a) => a.text).join("\n")).toContain("harrowpine")

    // The failed branch is reported as a dropped sub-call next to those
    // results in the tool outcome the follow-up turn carries.
    const journal = await project.journal()
    const followUps = journal.filter((e) => e.fixture === "c-c7-turn-done.yaml")
    expect(followUps.length).toBeGreaterThanOrEqual(1)
    const followUp = requestText(followUps[followUps.length - 1])
    expect(followUp).toContain("failed and were dropped")
    expect(followUp).toContain("callout-1c7bad00")
    expect(followUp).toContain("annotation(s) written")
  }
)
