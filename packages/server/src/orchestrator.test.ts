import { describe, expect, test } from "bun:test"
import { ObserverControlSchema } from "@argus/shared"
import { continuationInstruction } from "./prompts"
import { cutReasonOf, defaultMaxOutputTokens, defaultMaxSteps, isCutMessage, unmetCriteria } from "./orchestrator"

describe("cutReasonOf", () => {
  test("a normal stop is not a cut", () => {
    expect(cutReasonOf("stop", "end_turn", 3, 24)).toBeUndefined()
    expect(cutReasonOf("tool-calls", "tool_use", 3, 24)).toBeUndefined()
    expect(cutReasonOf("unknown", undefined, 3, 24)).toBeUndefined()
  })

  test("an output cap is a cut", () => {
    expect(cutReasonOf("length", "max_tokens", 1, 24)).toBe("length")
    expect(cutReasonOf(undefined, "max_tokens", 1, 24)).toBe("length")
    expect(cutReasonOf(undefined, "MAX_TOKENS", 1, 24)).toBe("length")
    expect(cutReasonOf(undefined, "max_output_tokens", 1, 24)).toBe("length")
  })

  test("the step limit is a cut when the model still wanted tools", () => {
    expect(cutReasonOf("other", undefined, 24, 24)).toBe("steps")
    expect(cutReasonOf(undefined, undefined, 24, 24)).toBe("steps")
    expect(cutReasonOf("length", undefined, 24, 24)).toBe("length")
    // The regression this guards: a tool loop stopped at the ceiling with the model still
    // asking for tools is a cut, not a finished turn.
    expect(cutReasonOf("tool-calls", "tool_use", 24, 24)).toBe("steps")
    expect(cutReasonOf("tool-calls", undefined, 24, 24)).toBe("steps")
  })

  test("with no step ceiling a long tool loop is not a cut", () => {
    // Argus no longer caps steps, so a big step count is normal and must stay a finished turn.
    const ceiling = defaultMaxSteps()
    expect(ceiling).toBeGreaterThan(200)
    expect(cutReasonOf("tool-calls", "tool_use", 500, ceiling)).toBeUndefined()
    expect(cutReasonOf("stop", "end_turn", 500, ceiling)).toBeUndefined()
  })

  test("an explicit ARGUS_MAX_STEPS still puts a ceiling back", () => {
    const previous = process.env.ARGUS_MAX_STEPS
    process.env.ARGUS_MAX_STEPS = "6"
    try {
      expect(defaultMaxSteps()).toBe(6)
      expect(cutReasonOf("tool-calls", "tool_use", 6, defaultMaxSteps())).toBe("steps")
    } finally {
      if (previous === undefined) delete process.env.ARGUS_MAX_STEPS
      else process.env.ARGUS_MAX_STEPS = previous
    }
  })

  test("hitting the step limit on a natural stop is not a cut", () => {
    expect(cutReasonOf("stop", "end_turn", 24, 24)).toBeUndefined()
    // The model finished on the last step of the loop, so the turn really is done.
    expect(cutReasonOf("stop", undefined, 24, 24)).toBeUndefined()
  })

  test("tool calls under the step ceiling are not a cut", () => {
    expect(cutReasonOf("tool-calls", "tool_use", 23, 24)).toBeUndefined()
  })

  test("running under the step limit is not a cut", () => {
    expect(cutReasonOf("other", undefined, 23, 24)).toBeUndefined()
  })

  test("provider blocks are hard stops", () => {
    expect(cutReasonOf("content-filter", undefined, 1, 24)).toBe("content-filter")
    expect(cutReasonOf(undefined, "refusal", 1, 24)).toBe("content-filter")
    expect(cutReasonOf("error", undefined, 1, 24)).toBe("error")
  })

  test("the unified reason wins over a raw spelling it already normalized", () => {
    // Anthropic reports stop_reason max_tokens, which the SDK unified into "length".
    expect(cutReasonOf("length", "max_tokens", 1, 24)).toBe("length")
    // A raw "end_turn" beside an unrecognized unified reason must not read as a cut.
    expect(cutReasonOf("other", "end_turn", 1, 24)).toBeUndefined()
  })
})

describe("no Argus output ceiling", () => {
  test("no cap is requested unless one is configured", () => {
    const previous = process.env.ARGUS_MAX_OUTPUT_TOKENS
    delete process.env.ARGUS_MAX_OUTPUT_TOKENS
    try {
      // Undefined is the load-bearing value: it keeps maxOutputTokens out of the request so the
      // provider applies the model's own maximum.
      expect(defaultMaxOutputTokens()).toBeUndefined()
    } finally {
      if (previous !== undefined) process.env.ARGUS_MAX_OUTPUT_TOKENS = previous
    }
  })

  test("an explicit cap is honored", () => {
    const previous = process.env.ARGUS_MAX_OUTPUT_TOKENS
    process.env.ARGUS_MAX_OUTPUT_TOKENS = "4096"
    try {
      expect(defaultMaxOutputTokens()).toBe(4096)
    } finally {
      if (previous === undefined) delete process.env.ARGUS_MAX_OUTPUT_TOKENS
      else process.env.ARGUS_MAX_OUTPUT_TOKENS = previous
    }
  })

  test("an out-of-range cap is ignored rather than clamped into place", () => {
    const previous = process.env.ARGUS_MAX_OUTPUT_TOKENS
    process.env.ARGUS_MAX_OUTPUT_TOKENS = "0"
    try {
      expect(defaultMaxOutputTokens()).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.ARGUS_MAX_OUTPUT_TOKENS
      else process.env.ARGUS_MAX_OUTPUT_TOKENS = previous
    }
  })
})

describe("continuationInstruction", () => {
  test("tells the agent to resume rather than restart", () => {
    const text = continuationInstruction({ kind: "answerer", attempt: 1 })
    expect(text).toContain("Resume from the last unfinished sentence")
    expect(text).toContain("not thrown away")
  })

  test("a stuck loop is named and told to change approach", () => {
    const text = continuationInstruction({ kind: "answerer", attempt: 1, stuck: "repeated the bash call 6 times" })
    expect(text).toContain("repeated the bash call 6 times")
    expect(text).toContain("change tool, change target, or change strategy")
  })

  test("the observer is reminded its control block must still be emitted", () => {
    expect(continuationInstruction({ kind: "observer", attempt: 1 })).toContain("ARGUS_CONTROL")
  })

  test("the finalizer is reminded to finish the report", () => {
    expect(continuationInstruction({ kind: "finalizer", attempt: 1 })).toContain("finish every remaining section")
  })
})

describe("isCutMessage", () => {  test("reads the recorded cut reason off the metadata", () => {
    expect(isCutMessage({ metadata: { cut: "length" } })).toBe(true)
    expect(isCutMessage({ metadata: { cut: "steps" } })).toBe(true)
    expect(isCutMessage({ metadata: {} })).toBe(false)
    expect(isCutMessage({ metadata: { cut: 3 } })).toBe(false)
    expect(isCutMessage({ metadata: null })).toBe(false)
    expect(isCutMessage(undefined)).toBe(false)
  })
})

describe("observer control after a cut", () => {
  // A turn cut before its control block filed no rulings. It must never parse as one that did,
  // or the round would advance on a verdict the Observer never actually made.
  test("a control block missing because of truncation is reported as a non-ruling", () => {
    const control = {
      decision: "continue",
      feedback: "partial critique",
      missing: ["The Observer's turn was cut off before it filed its control block, so no criterion was ruled on this round"],
      nextFocus: [],
      criterionEvaluations: [],
    }
    const parsed = ObserverControlSchema.parse(control)
    expect(parsed.decision).toBe("continue")
    expect(parsed.criterionEvaluations).toEqual([])
  })

  test("a complete control block still validates", () => {
    const parsed = ObserverControlSchema.parse({
      decision: "complete",
      feedback: "closed",
      missing: [],
      nextFocus: [],
      criterionEvaluations: [{ criterionId: "AC-1", status: "met", rationale: "check passed" }],
      completionReason: "all criteria verified",
    })
    expect(parsed.decision).toBe("complete")
  })

  test("complete without a reason is rejected", () => {
    expect(ObserverControlSchema.safeParse({
      decision: "complete",
      feedback: "closed",
      missing: [],
      nextFocus: [],
      criterionEvaluations: [],
    }).success).toBe(false)
  })
})

describe("closure requires every framed criterion to be ruled met", () => {
  const frame = [{ id: "AC-1" }, { id: "AC-2" }, { id: "AC-3" }]

  test("a complete verdict with all criteria met closes the run", () => {
    const control = {
      criterionEvaluations: [
        { criterionId: "AC-1", status: "met", rationale: "ok" },
        { criterionId: "AC-2", status: "met", rationale: "ok" },
        { criterionId: "AC-3", status: "met", rationale: "ok" },
      ],
    } as const
    expect(unmetCriteria(frame, control)).toEqual([])
  })

  // The reported failure: the Observer calls the problem open and declares completion anyway.
  test("declaring the problem open cannot close the run", () => {
    const control = {
      criterionEvaluations: [
        { criterionId: "AC-1", status: "met", rationale: "ok" },
        { criterionId: "AC-2", status: "not_met", rationale: "could not reproduce" },
        { criterionId: "AC-3", status: "met", rationale: "ok" },
      ],
    } as const
    expect(unmetCriteria(frame, control)).toEqual(["AC-2"])
  })

  test("a criterion the Observer never ruled on counts as unmet", () => {
    const control = {
      criterionEvaluations: [{ criterionId: "AC-1", status: "met", rationale: "ok" }],
    } as const
    expect(unmetCriteria(frame, control)).toEqual(["AC-2", "AC-3"])
  })

  test("an empty ruling set closes nothing", () => {
    expect(unmetCriteria(frame, { criterionEvaluations: [] })).toEqual(["AC-1", "AC-2", "AC-3"])
  })

  test("a ruling for an unknown criterion cannot stand in for a real one", () => {
    const control = {
      criterionEvaluations: [
        { criterionId: "AC-1", status: "met", rationale: "ok" },
        { criterionId: "AC-9", status: "met", rationale: "invented" },
      ],
    } as const
    expect(unmetCriteria(frame, control)).toEqual(["AC-2", "AC-3"])
  })
})
