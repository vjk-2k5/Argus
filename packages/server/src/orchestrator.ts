import { generateText, stepCountIs, streamText, type ModelMessage } from "ai"
import {
  FrameSchema,
  ObserverControlSchema,
  type Frame,
  type ObserverControl,
  type Part,
  type RoleModelConfig,
  type ToolInvocation,
} from "@argus/shared"
import {
  completedMessage,
  completeMessage,
  createCompaction,
  createMessage,
  getSession,
  latestCompaction,
  listMessages,
  updateMessage,
  updateSession,
  type MessageRow,
  type SessionRow,
} from "./db"
import { publish } from "./events"
import { contextWindow, maxOutputTokens as providerMaxOutputTokens, resolveModel } from "./providers"
import {
  ANSWERER_HIDDEN_VERIFICATION_NOTICE,
  ANSWERER_SYSTEM,
  FINALIZER_SYSTEM,
  FRAMER_SYSTEM,
  OBSERVER_SYSTEM,
  VERIFICATION_SEALED_NOTICE,
  answererFrameText,
  continuationInstruction,
  framePrompt,
  frameText,
  observerFrameText,
  workspaceBrief,
} from "./prompts"
import { buildToolset } from "./tools/registry"
import { ensureWorkspace, workspaceFor } from "./tools/fs"

const runs = new Map<string, { controller: AbortController; promise: Promise<void> }>()
const CONTROL_OPEN = "<ARGUS_CONTROL>"
const CONTROL = /<ARGUS_CONTROL>([\s\S]*?)<\/ARGUS_CONTROL>/i

function parseJson(text: string) {
  const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
  const start = clean.indexOf("{")
  const end = clean.lastIndexOf("}")
  if (start < 0 || end < start) throw new Error("Model did not return a JSON object")
  return JSON.parse(clean.slice(start, end + 1)) as unknown
}

function usage(value: unknown) {
  const item = (value ?? {}) as Record<string, unknown>
  const input = Number(item.inputTokens ?? item.promptTokens ?? 0)
  const output = Number(item.outputTokens ?? item.completionTokens ?? 0)
  return { input: Number.isFinite(input) ? input : 0, output: Number.isFinite(output) ? output : 0 }
}

function estimate(text: string) {
  return Math.ceil(text.length / 4)
}

function abortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message))
}

/**
 * Argus imposes no output or step ceiling of its own. Omitting maxOutputTokens leaves each
 * provider to apply the model's own maximum, and an effectively unbounded step count lets a tool
 * loop run until the model stops asking for tools. Set ARGUS_MAX_STEPS or
 * ARGUS_MAX_OUTPUT_TOKENS to put a ceiling back.
 */
const MIN_MAX_OUTPUT_TOKENS = 256
const MAX_MAX_OUTPUT_TOKENS = 65_536
const DEFAULT_MAX_CONTINUATIONS = 2
/** Stand-in for "no step ceiling". Large enough never to be reached, small enough to stay a number. */
const STEP_CEILING = 1_000_000
/** Identical consecutive tool calls tolerated before a turn is treated as a stuck loop. */
const DOOM_LOOP_THRESHOLD = 6

export function defaultMaxSteps() {
  const raw = process.env.ARGUS_MAX_STEPS?.trim()
  if (!raw) return STEP_CEILING
  const value = Number(raw)
  return Number.isInteger(value) && value >= 1 && value <= STEP_CEILING ? value : STEP_CEILING
}

function defaultMaxContinuations() {
  const value = Number(process.env.ARGUS_MAX_CONTINUATIONS ?? DEFAULT_MAX_CONTINUATIONS)
  return Number.isInteger(value) && value >= 0 && value <= 8 ? value : DEFAULT_MAX_CONTINUATIONS
}

/**
 * Why a turn ended early. `length` means the provider stopped at its output cap mid-sentence and
 * `steps` means Argus stopped the tool loop; both leave a turn that has not actually finished, so
 * the round cannot be judged yet. `content-filter` and `error` are hard stops.
 */
export type CutReason = "length" | "steps" | "content-filter" | "error"

/** Providers spell this several ways; the AI SDK normalizes most, but not all adapters do. */
const LENGTH_REASONS = new Set(["length", "max-tokens", "max_tokens", "maxtokens", "max_output_tokens"])
/** The model asked for more tools, so it had not finished when the step ceiling stopped it. */
const TOOL_CALL_REASONS = new Set(["tool-calls", "tool_calls", "function_call"])
/** The model ended the turn on its own terms, so the turn really is finished. */
const STOP_REASONS = new Set(["stop", "end_turn", "stop_sequence", "pause_turn", "unknown"])

type Verdict = CutReason | "stop" | "tools" | undefined

function classify(reason: string): Verdict {
  if (LENGTH_REASONS.has(reason)) return "length"
  if (reason === "content-filter" || reason === "content_filter" || reason === "contentfilter" || reason === "refusal") return "content-filter"
  if (reason === "error") return "error"
  if (TOOL_CALL_REASONS.has(reason)) return "tools"
  return STOP_REASONS.has(reason) ? "stop" : undefined
}

export function cutReasonOf(
  finishReason: string | undefined,
  rawFinishReason: string | undefined,
  steps: number,
  maxSteps: number,
): CutReason | undefined {
  // The unified reason is already normalized by the AI SDK, so it wins. The raw one is only a
  // fallback for adapters that pass a provider spelling straight through (Anthropic says
  // "max_tokens" and "refusal", where the unified reason says "length" and "content-filter").
  const unified = classify((finishReason ?? "").trim().toLowerCase())
  const raw = classify((rawFinishReason ?? "").trim().toLowerCase())
  const decided = unified ?? raw
  if (decided === "length" || decided === "content-filter" || decided === "error") return decided
  // Argus stopped the tool loop at the step ceiling. A model that was still asking for tools
  // never concluded anything, so this is a cut just as real as an output cap. A model that had
  // already stopped on its own finished the turn even if it landed on the last step.
  if (decided === "tools") return steps >= maxSteps ? "steps" : undefined
  if (decided === "stop") return undefined
  if (steps >= maxSteps) return "steps"
  return undefined
}

export function isCutMessage(message: Pick<MessageRow, "metadata"> | undefined) {
  return typeof message?.metadata?.cut === "string"
}

export function sessionWorkspace(session: SessionRow) {
  return session.workspace || workspaceFor(session.title, session.problem, session.id)
}

/**
 * The output ceiling Argus asks for, or undefined to ask for none. Anthropic requires max_tokens
 * and falls back to the model's own maximum when the field is absent, and the other providers do
 * the same, so leaving it unset is what "no cap" actually means at the API level.
 */
export function defaultMaxOutputTokens() {
  const raw = process.env.ARGUS_MAX_OUTPUT_TOKENS?.trim()
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value >= MIN_MAX_OUTPUT_TOKENS && value <= MAX_MAX_OUTPUT_TOKENS
    ? value
    : undefined
}

function modelOptions(config: RoleModelConfig) {
  const options = { ...config.options } as Record<string, unknown>
  const configured = options.maxOutputTokens
  const requested = typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? configured
    : defaultMaxOutputTokens()
  if (requested === undefined) {
    // No ceiling from Argus: let the provider apply the model's own maximum.
    const { maxOutputTokens: _omitted, ...rest } = options
    return rest
  }
  // A ceiling was asked for, so it is clamped to what the model can actually produce.
  const discovered = providerMaxOutputTokens(config)
  return {
    ...options,
    maxOutputTokens: discovered ? Math.min(requested, discovered) : requested,
  }
}

async function runFraming(sessionId: string, controller: AbortController) {
  const session = getSession(sessionId)
  if (!session || session.status !== "framing") return
  const access = session.toolAccess ?? "off"
  try {
    const message = await streamAgent({
      session,
      role: "framer",
      round: 0,
      model: session.roles.framer,
      system: `${FRAMER_SYSTEM}\n\n${workspaceBrief({ toolAccess: access, workspace: sessionWorkspace(session), problem: session.problem })}`,
      messages: [{ role: "user", content: framePrompt(session.problem, session.maxRounds, access) }],
      signal: controller.signal,
    })
    const current = getSession(sessionId)
    if (controller.signal.aborted || !current || current.status !== "framing") return
    const frame = FrameSchema.parse(parseJson(message.text))
    updateSession(sessionId, {
      title: frame.title,
      frame,
      maxRounds: frame.maxRounds,
      status: "awaiting_approval",
      error: null,
    })
    publish(sessionId, { type: "frame.updated", frame, approved: false })
    publish(sessionId, { type: "session.status", status: "awaiting_approval" })
  } catch (error) {
    const current = getSession(sessionId)
    if (controller.signal.aborted || current?.status === "cancelled" || abortError(error)) return
    const message = error instanceof Error ? error.message : String(error)
    if (current?.status === "framing") updateSession(sessionId, { status: "failed", error: message })
    publish(sessionId, { type: "error", code: "FRAMING_FAILED", message })
    publish(sessionId, { type: "session.status", status: "failed" })
  }
}

export function frameSession(sessionId: string) {
  const active = runs.get(sessionId)
  if (active) return active.promise
  const controller = new AbortController()
  const entry = { controller, promise: Promise.resolve() as Promise<void> }
  entry.promise = runFraming(sessionId, controller).finally(() => {
    if (runs.get(sessionId) === entry) runs.delete(sessionId)
  })
  runs.set(sessionId, entry)
  return entry.promise
}

function visibleStreamText(raw: string, stripControl: boolean, final: boolean) {
  if (!stripControl) return raw
  const controlAt = raw.toLowerCase().indexOf(CONTROL_OPEN.toLowerCase())
  if (controlAt >= 0) return raw.slice(0, controlAt)
  if (final) return raw
  return raw.slice(0, Math.max(0, raw.length - CONTROL_OPEN.length + 1))
}

async function streamAgent(input: {
  session: SessionRow
  role: "framer" | "answerer" | "observer"
  round: number
  system: string
  messages: ModelMessage[]
  model: RoleModelConfig
  signal: AbortSignal
  metadata?: Record<string, unknown>
  stripControl?: boolean
}) {
  const message = createMessage({
    id: crypto.randomUUID(),
    sessionId: input.session.id,
    role: input.role,
    round: input.round,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  })
  publish(input.session.id, {
    type: "message.started",
    messageId: message.id,
    role: input.role,
    round: input.round,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  })

  const access = input.session.toolAccess ?? "off"
  const toolCalls: ToolInvocation[] = []
  const parts: Part[] = []
  // Text and reasoning each accumulate into their open part. A tool call closes both, so the
  // next token starts a fresh part and the turn reads reasoning, tool, reasoning, tool, text.
  let openText: Part | undefined
  let openReasoning: Part | undefined
  const metadata = (extra?: Record<string, unknown>) => ({
    ...input.metadata,
    ...extra,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(parts.length > 0 ? { parts } : {}),
  })

  const closeOpenParts = () => {
    if (openText) {
      publish(input.session.id, { type: "part.completed", messageId: message.id, partId: openText.id })
      openText = undefined
    }
    if (openReasoning) {
      publish(input.session.id, { type: "part.completed", messageId: message.id, partId: openReasoning.id })
      openReasoning = undefined
    }
  }

  const startPart = (kind: "text" | "reasoning") => {
    const part: Part = { id: `${message.id}:${kind}:${parts.length}`, kind, text: "" }
    parts.push(part)
    publish(input.session.id, { type: "part.started", messageId: message.id, partId: part.id, kind })
    return part
  }

  const toolset = access === "off"
    ? undefined
    : buildToolset({
      sessionId: input.session.id,
      messageId: message.id,
      workspace: await ensureWorkspace(sessionWorkspace(input.session)),
      access,
      signal: input.signal,
      onUpdate: (invocation) => {
        const index = toolCalls.findIndex((item) => item.id === invocation.id)
        if (index < 0) {
          toolCalls.push(invocation)
          // The call sits where it happened, so whatever came before it is finished.
          closeOpenParts()
          parts.push({ id: `${message.id}:tool:${invocation.id}`, kind: "tool", text: "", toolId: invocation.id })
          publish(input.session.id, { type: "part.started", messageId: message.id, partId: `${message.id}:tool:${invocation.id}`, kind: "tool" })
        } else {
          toolCalls[index] = invocation
        }
        updateMessage(message.id, { metadata: metadata() })
        publish(input.session.id, { type: "tool.updated", messageId: message.id, tool: invocation })
      },
      onQuestion: (question, options) => {
        publish(input.session.id, { type: "question.asked", messageId: message.id, question, options })
      },
    })

  // Only `inputSchema` makes the SDK derive a complete JSON Schema. Handing it the legacy
  // `parameters` field instead yields a schema with no root `type`, which Bedrock rejects
  // outright ("inputSchema.json.type must be one of the following: object").
  const tools = toolset && Object.fromEntries(
    Object.entries(toolset).map(([name, entry]) => [
      name,
      { description: entry.description, inputSchema: entry.parameters, execute: entry.execute },
    ]),
  )

  let rawText = ""
  let text = ""
  let reasoning = ""
  const maxSteps = defaultMaxSteps()
  let steps = 0
  let stuckLoop: string | undefined
  let finishReason: string | undefined
  let rawFinishReason: string | undefined
  try {
    const result = streamText({
      ...modelOptions(input.model),
      model: resolveModel(input.model),
      system: input.system,
      messages: input.messages,
      abortSignal: input.signal,
      ...(tools ? { tools, stopWhen: stepCountIs(maxSteps) } : {}),
    } as any)

    for await (const event of result.fullStream) {
      const value = event as unknown as Record<string, unknown>
      if (event.type === "text-delta") {
        const delta = String(value.text ?? value.textDelta ?? "")
        rawText += delta
        const visible = visibleStreamText(rawText, input.stripControl === true, false)
        const visibleDelta = visible.slice(text.length)
        text = visible
        if (visibleDelta) {
          openText ??= startPart("text")
          openText.text += visibleDelta
          publish(input.session.id, { type: "part.delta", messageId: message.id, partId: openText.id, kind: "text", delta: visibleDelta })
        }
        updateMessage(message.id, { text, metadata: metadata() })
      } else if (event.type === "reasoning-delta") {
        const delta = String(value.text ?? value.textDelta ?? "")
        reasoning += delta
        openReasoning ??= startPart("reasoning")
        openReasoning.text += delta
        publish(input.session.id, { type: "part.delta", messageId: message.id, partId: openReasoning.id, kind: "reasoning", delta })
        updateMessage(message.id, { reasoning, metadata: metadata() })
      } else if (event.type === "start-step") {
        steps++
        // Without a step ceiling, a model stuck on one identical call would loop forever. Detect
        // that repetition and end the turn, which is the same guard opencode applies. Breaking out
        // of the loop rather than throwing keeps this a cut, not a pause of the whole run.
        if (toolCalls.length >= DOOM_LOOP_THRESHOLD) {
          const tail = toolCalls.slice(-DOOM_LOOP_THRESHOLD)
          const repeated = tail.every((call) =>
            call.state !== "pending"
            && call.name === tail[0]!.name
            && JSON.stringify(call.arguments) === JSON.stringify(tail[0]!.arguments))
          if (repeated) {
            stuckLoop = `repeated the ${tail[0]!.name} call ${DOOM_LOOP_THRESHOLD} times without changing it`
            break
          }
        }
      } else if (event.type === "error") {
        throw value.error ?? new Error("Model stream failed")
      }
    }
    const finalText = input.stripControl ? cleanObserverText(rawText) : rawText
    const finalDelta = finalText.slice(text.length)
    text = finalText
    if (finalDelta) {
      openText ??= startPart("text")
      openText.text += finalDelta
      publish(input.session.id, { type: "part.delta", messageId: message.id, partId: openText.id, kind: "text", delta: finalDelta })
    }
    closeOpenParts()

    // The stream's `finish-step` events carry no reason and `finish` carries no raw spelling, so
    // read the reasons the result resolves them to rather than off the event stream. The SDK
    // rejects both when a stream produced no steps at all, which is already handled above. When the
    // loop was cut short the stream was never finished, so the promises may never settle; the
    // stuck-loop reason already explains the turn and is not worth waiting on.
    if (!stuckLoop) {
      const reported = result as unknown as {
        finishReason?: Promise<string>
        rawFinishReason?: Promise<string | undefined>
      }
      finishReason = await (reported.finishReason ?? Promise.resolve(finishReason)).catch(() => finishReason)
      rawFinishReason = await (reported.rawFinishReason ?? Promise.resolve(rawFinishReason)).catch(() => rawFinishReason)
    }

    // The turn stopped because a limit was reached, not because the agent finished. Record it so
    // the orchestrator can resume the same turn instead of handing a half-answer to the next agent.
    const cut: CutReason | undefined = stuckLoop ? "steps" : cutReasonOf(finishReason, rawFinishReason, steps, maxSteps)
    const blocked = cut === "content-filter" || cut === "error"
    if (blocked) {
      throw new Error(cut === "content-filter"
        ? "The provider stopped the response with its content filter"
        : "The provider reported an error while streaming")
    }
    if (cut) {
      publish(input.session.id, { type: "turn.cut", messageId: message.id, round: input.round, reason: cut })
    }
    updateMessage(message.id, { metadata: metadata(cut ? { cut, steps, ...(stuckLoop ? { stuckLoop } : {}) } : undefined) })
    const streamResult = result as unknown as { totalUsage?: Promise<unknown>; usage?: Promise<unknown> }
    const totals = usage(await (streamResult.totalUsage ?? streamResult.usage ?? Promise.resolve(undefined)).catch(() => usage(undefined)))
    const completed = completeMessage(message.id, {
      status: "completed",
      text,
      reasoning,
      metadata: metadata({
        ...(cut ? { cut, steps, ...(stuckLoop ? { stuckLoop } : {}) } : {}),
        ...(input.stripControl ? { control: observerControl(rawText, cut) } : {}),
      }),
      inputTokens: totals.input,
      outputTokens: totals.output,
    })
    publish(input.session.id, { type: "message.completed", messageId: message.id })
    const current = getSession(input.session.id)!
    publish(input.session.id, {
      type: "usage.updated",
      inputTokens: current.inputTokens,
      outputTokens: current.outputTokens,
      costUsd: current.costUsd,
    })
    return completed
  } catch (error) {
    const aborted = input.signal.aborted || abortError(error)
    closeOpenParts()
    completeMessage(message.id, {
      status: aborted ? "aborted" : "failed",
      text,
      reasoning,
      metadata: metadata({ error: error instanceof Error ? error.message : String(error) }),
    })
    throw error
  }
}

const TOOL_LOG_LIMIT = 12
const TOOL_OUTPUT_SNIPPET = 400

/** Compact record of what an agent actually did, so later turns and compaction keep the evidence. */
function toolLog(message: MessageRow) {
  const raw = message.metadata?.toolCalls
  if (!Array.isArray(raw) || raw.length === 0) return ""
  const calls = raw as ToolInvocation[]
  const lines = calls.slice(-TOOL_LOG_LIMIT).map((call) => {
    const status = call.state === "completed" ? "ok" : call.state === "failed" ? `FAILED: ${call.error ?? "unknown error"}` : call.state
    const body = call.state === "completed" ? call.output : call.error ?? ""
    const snippet = body
      ? `\n      ${body.slice(0, TOOL_OUTPUT_SNIPPET).split("\n").join("\n      ")}${body.length > TOOL_OUTPUT_SNIPPET ? " …" : ""}`
      : ""
    return `  - ${call.name}: ${call.title || "(no target)"} [${status}]${snippet}`
  })
  const omitted = calls.length > TOOL_LOG_LIMIT ? `\n  (${calls.length - TOOL_LOG_LIMIT} earlier tool calls omitted)` : ""
  return `\n[Tool activity]\n${lines.join("\n")}${omitted}`
}

function transcript(messages: MessageRow[]) {
  return messages
    .filter((message: MessageRow) => message.status === "completed" && (message.role === "answerer" || message.role === "observer") && message.metadata?.final !== true)
    .map((message: MessageRow) => {
      // A continued turn is labelled so the model reads its own cut-off output plus the
      // continuation as one piece of work, not as two separate attempts.
      const cut = typeof message.metadata?.cut === "string" ? `\n(cut off by the ${message.metadata.cut} limit)` : ""
      const segment = typeof message.metadata?.continuation === "number" ? " continued" : ""
      return `[Round ${message.round} · ${message.role}${segment}]\n${message.text}${cut}${toolLog(message)}`
    })
    .join("\n\n")
}

function contextMessages(sessionId: string) {
  const all = listMessages(sessionId).filter((message: MessageRow) => message.status === "completed")
  const compacted = latestCompaction(sessionId)
  if (!compacted) return { summary: "", messages: all }
  const index = all.findIndex((message: MessageRow) => message.id === compacted.throughMessageId)
  return { summary: compacted.summary, messages: index < 0 ? all : all.slice(index + 1) }
}

function sessionContextWindow(session: SessionRow) {
  return Math.min(
    contextWindow(session.roles.answerer),
    contextWindow(session.roles.observer),
  )
}

async function compactIfNeeded(session: SessionRow, signal: AbortSignal) {
  const usable = Math.max(4_000, sessionContextWindow(session) - Number(process.env.ARGUS_COMPACTION_RESERVED_TOKENS ?? 20_000))
  const state = contextMessages(session.id)
  const candidates = state.messages.filter((message: MessageRow) => message.role === "answerer" || message.role === "observer")
  const context = `${state.summary}\n${frameText(session.frame!)}\n${transcript(candidates)}`
  if (estimate(context) < usable || candidates.length < 2) return

  const tailBudget = Math.min(15_000, Math.max(2_000, Math.floor(usable * 0.25)))
  let tailTokens = 0
  let split = candidates.length
  for (let index = candidates.length - 1; index >= 0; index--) {
    const size = estimate(transcript([candidates[index]!]))
    if (tailTokens + size > tailBudget) break
    tailTokens += size
    split = index
  }
  const head = candidates.slice(0, split)
  if (head.length === 0) return
  const maxChars = Math.max(8_000, (usable - 4_000) * 4)
  const source = transcript(head).slice(-maxChars)
  const result = await generateText({
    ...modelOptions(session.roles.observer),
    model: resolveModel(session.roles.observer),
    system: "You compact Argus debate state. Preserve hypotheses, derivations, counterexamples, claim qualifications, observer objections, acceptance-criteria progress, and unresolved bottlenecks. Preserve tool-derived facts with their exact provenance: every file path created or modified and what is in it, every command run with its exit status and result, every URL actually fetched and what it said, and every search that was performed. Preserve provenance: any citation, paper, URL, external verification, experiment, code run, simulation, Monte Carlo result, or peer-review claim that the tool activity does not show as actually performed must remain marked unverified or unperformed. Never invent, complete, repair, or validate bibliographic details or links, and never convert a proposed check into a completed result. This summary is read by both agents, so never record a criterion's verification recipe, the specific file, command, or URL the Observer uses to check it, or any other hint at how the Observer tests a criterion: refer to criteria by ID and required result only.",
    prompt: `Previous summary:\n${state.summary || "None"}\n\nConversation to compact:\n${source}\n\nWrite a dense continuation summary for both agents. Keep all unsupported external claims explicitly unverified and all proposed executions explicitly unperformed. Keep every criterion's verification method out of the summary.`,
    abortSignal: signal,
  } as any)
  const totals = usage(result.usage)
  const compaction = createCompaction({
    id: crypto.randomUUID(),
    sessionId: session.id,
    throughMessageId: head.at(-1)!.id,
    round: head.at(-1)!.round,
    summary: result.text,
    inputTokens: totals.input,
    outputTokens: totals.output,
    createdAt: Date.now(),
  })
  publish(session.id, { type: "compaction.created", id: compaction.id, summary: compaction.summary })
  const current = getSession(session.id)!
  publish(session.id, {
    type: "usage.updated",
    inputTokens: current.inputTokens,
    outputTokens: current.outputTokens,
    costUsd: current.costUsd,
  })
}

type DebateRole = "answerer" | "observer"
type ConversationRole = "user" | "assistant"

function appendConversationMessage(messages: ModelMessage[], role: ConversationRole, content: string) {
  const previous = messages.at(-1)
  if (previous?.role === role && typeof previous.content === "string") {
    messages[messages.length - 1] = { role, content: `${previous.content}\n\n${content}` }
    return
  }
  messages.push({ role, content })
}

function debateTurn(message: MessageRow & { role: DebateRole }, target: DebateRole) {
  const label = message.role === "answerer" ? "Answer Agent" : "Observer / Questioner"
  const parsedControl = message.role === "observer"
    ? ObserverControlSchema.safeParse(message.metadata?.control)
    : undefined
  const control = parsedControl?.success ? parsedControl.data : undefined
  const controlText = !control
    ? ""
    : target === "observer"
      ? `\n\n<ARGUS_CONTROL>${JSON.stringify(control)}</ARGUS_CONTROL>`
      : renderGuidance(control)

/**
 * The Answer Agent's view of the Observer's verdict. The sub-goal frontier is the working surface
 * it is meant to advance, so it is rendered as a list rather than left buried in JSON.
 */
function renderGuidance(control: ObserverControl) {
  const lines = [
    "",
    "[Observer control guidance]",
    `decision: ${control.decision}`,
    `feedback: ${control.feedback}`,
  ]
  if (control.subGoals.length > 0) {
    lines.push("frontier (work these in order; keep results you already have):")
    for (const goal of control.subGoals) {
      lines.push(`  - ${goal.criterionId} [${goal.state}] ${goal.step}${goal.note ? ` -- ${goal.note}` : ""}`)
    }
  }
  if (control.nextFocus.length > 0) {
    lines.push("next steps:")
    for (const focus of control.nextFocus) lines.push(`  - ${focus}`)
  }
  return `\n${lines.join("\n")}`
}
  // The agent reading this needs to know the turn was truncated, so it resumes rather than
  // treating a half-sentence as the finished position.
  const cut = typeof message.metadata?.cut === "string"
    ? `\n(this turn was cut off by the ${message.metadata.cut} limit${typeof message.metadata.continuation === "number" ? " and was continued" : ""})`
    : ""
  return `[${label} · Round ${message.round}]\n${message.text}${cut}${toolLog(message)}${controlText}`
}

async function agentConversation(
  session: SessionRow,
  target: DebateRole,
  instruction: string,
  signal: AbortSignal,
) {
  await compactIfNeeded(session, signal)
  const state = contextMessages(session.id)
  const messages: ModelMessage[] = []

  if (state.summary) {
    appendConversationMessage(messages, "user", "What happened in the debate before the retained conversation?")
    appendConversationMessage(messages, "assistant", `[Compacted prior debate]\n${state.summary}`)
  }

  for (const message of state.messages) {
    if (
      message.status !== "completed" ||
      (message.role !== "answerer" && message.role !== "observer") ||
      message.metadata?.final === true
    ) continue
    const role: ConversationRole = message.role === target ? "assistant" : "user"
    appendConversationMessage(messages, role, debateTurn(message as MessageRow & { role: DebateRole }, target))
  }

  appendConversationMessage(messages, "user", instruction)
  return messages
}

function observerControl(text: string, cut?: string): ObserverControl {
  const match = text.match(CONTROL)
  // A turn cut before its control block never ruled on anything, so it cannot read as a verdict.
  // It reports nothing missing only when the model simply never opened a block.
  const lost = cut ? ["The Observer's turn was cut off before it filed its control block, so no criterion was ruled on this round"] : undefined
  if (!match?.[1]) {
    return {
      decision: "continue",
      feedback: cleanObserverText(text) || "Continue with a materially different attack.",
      missing: lost ?? (text.toLowerCase().includes(CONTROL_OPEN.toLowerCase()) ? ["Observer control block was invalid"] : []),
      nextFocus: [],
      subGoals: [],
      criterionEvaluations: [],
    }
  }
  try {
    return ObserverControlSchema.parse(JSON.parse(match[1]))
  } catch {
    return {
      decision: "continue",
      feedback: cleanObserverText(text) || "Continue with a materially different attack.",
      missing: lost ?? ["Observer control block was invalid"],
      nextFocus: [],
      subGoals: [],
      criterionEvaluations: [],
    }
  }
}

function cleanObserverText(text: string) {
  const controlAt = text.toLowerCase().indexOf(CONTROL_OPEN.toLowerCase())
  return (controlAt >= 0 ? text.slice(0, controlAt) : text.replace(CONTROL, "")).trim()
}

/**
 * Runs one agent turn and, if the provider cut it off at an output or step limit, resumes the
 * same turn. A cut turn is not a finished turn, so the round does not advance and the other agent
 * never sees a half-answer: this is what stops a model that thinks too long from burning every
 * round on truncated responses. Continuations are bounded so a model that can never finish still
 * makes progress instead of looping forever.
 */
async function runTurn(input: {
  session: SessionRow
  role: DebateRole
  kind: "answerer" | "observer" | "finalizer"
  round: number
  system: string
  instruction: string
  signal: AbortSignal
  stripControl?: boolean
  metadata?: Record<string, unknown>
  maxContinuations?: number
}) {
  const budget = input.maxContinuations ?? defaultMaxContinuations()
  let message: MessageRow | undefined
  let attempt = 0
  while (true) {
    if (input.signal.aborted) throw new DOMException("Paused", "AbortError")
    const current = getSession(input.session.id)
    if (!current) throw new Error("Session disappeared mid-turn")
    const messages = await agentConversation(
      current,
      input.role,
      attempt === 0
        ? input.instruction
        : continuationInstruction({
          kind: input.kind,
          attempt,
          ...(typeof message?.metadata?.stuckLoop === "string" ? { stuck: message.metadata.stuckLoop } : {}),
        }),
      input.signal,
    )
    const metadata = attempt === 0
      ? input.metadata
      : { ...input.metadata, continuation: attempt, continuesFrom: message!.id }
    message = await streamAgent({
      session: current,
      role: input.role,
      round: input.round,
      model: current.roles[input.role],
      system: input.system,
      messages,
      signal: input.signal,
      ...(input.stripControl ? { stripControl: true } : {}),
      ...(metadata ? { metadata } : {}),
    })
    if (!isCutMessage(message) || attempt >= budget) return message
    attempt++
    publish(input.session.id, { type: "turn.continued", messageId: message.id, round: input.round, attempt })
  }
}

/**
 * Criterion IDs the Observer reported as NOT MET, or never ruled on at all.
 *
 * A criterion missing from the block counts as unmet: silence is not a pass.
 */
export function unmetCriteria(
  criteria: ReadonlyArray<{ id: string }>,
  control: { criterionEvaluations: ReadonlyArray<{ criterionId: string; status: string }> },
) {
  const ruled = new Map(control.criterionEvaluations.map((entry) => [entry.criterionId, entry.status]))
  return criteria
    .filter((criterion) => ruled.get(criterion.id) !== "met")
    .map((criterion) => criterion.id)
}

/** Restates a rejected closure so the next round knows the previous verdict was not honoured. */
function carriedRejection(carryOver?: string) {
  return carryOver ? `\n\n${carryOver}` : ""
}

async function executeRound(session: SessionRow, round: number, signal: AbortSignal, carryOver?: string) {
  const active = getSession(session.id)
  if (!active || active.status !== "running" || signal.aborted) throw new DOMException("Stopped", "AbortError")
  updateSession(session.id, { currentRound: round, status: "running" })
  publish(session.id, { type: "round.started", round })

  let answer = completedMessage(session.id, round, "answerer")
  if (!answer || isCutMessage(answer)) {
    const current = getSession(session.id)!
    answer = await runTurn({
      session: current,
      role: "answerer",
      kind: "answerer",
      round,
      system: `${ANSWERER_SYSTEM}\n\n${ANSWERER_HIDDEN_VERIFICATION_NOTICE}\n\nApproved task frame:\n${answererFrameText(current.frame!)}\n\n${workspaceBrief({ toolAccess: current.toolAccess ?? "off", workspace: sessionWorkspace(current), problem: current.problem })}`,
      instruction: `Produce the Round ${round} candidate solution. Continue from your own prior assistant turns rather than restarting. Use the available tools to obtain evidence instead of asserting from memory: inspect the workspace, run the computation, or fetch the source, and cite the exact path, command, or URL behind every material claim. Drive the problem toward complete closure, address every acceptance criterion, and act on every Observer critique and control instruction. If a prior approach or tool call failed, treat it as information about which route is exhausted and change route; never treat it as a reason to stop, and never report the problem as open, unsolved, or beyond reach while an approach you have not tried could still reach the criterion. If you believe you are close, use the remaining output and step budget to get there. Work the Observer's subGoals list rather than restarting the problem: pick the blocked or attempted step, remove that one obstacle, keep the results you already have, and say which entries advanced. Do not answer with a new obstacle of your own invention while an obstacle the Observer already named is still standing - if the step you were directed at genuinely cannot be removed, show exactly which sub-step fails and what it would take to remove it, rather than restating the difficulty and asking for another idea.${carryOver ?? ""} Work as long as the problem needs, and take as many tool steps as it takes, but do not narrate the reasoning at length: reason to a conclusion and then state it.`,
      signal,
    })
  }
  if (signal.aborted) throw new DOMException("Paused", "AbortError")

  // Continuations are spent and the Answer Agent still could not finish. The candidate on the
  // table is partial, so say so rather than letting it be judged as a complete answer.
  const truncated = isCutMessage(answer)
    ? `\n\nThe Answer Agent's Round ${round} candidate is INCOMPLETE: it hit the ${answer!.metadata?.cut} limit and could not be continued further. Judge only what it actually produced, rule NOT MET on any criterion its partial output does not establish, and tell it to finish the unfinished work.`
    : ""

  let observation = completedMessage(session.id, round, "observer")
  let control: ObserverControl
  if (!observation || isCutMessage(observation)) {
    const current = getSession(session.id)!
    observation = await runTurn({
      session: current,
      role: "observer",
      kind: "observer",
      round,
      system: `${OBSERVER_SYSTEM}\n\n${VERIFICATION_SEALED_NOTICE}\n\nApproved task frame, including the verification method for each criterion:\n${observerFrameText(current.frame!)}\n\n${workspaceBrief({ toolAccess: current.toolAccess ?? "off", workspace: sessionWorkspace(current), problem: current.problem })}`,
      stripControl: true,
      instruction: `Independently verify the Answer Agent's Round ${round} candidate now present in the conversation and continue from your own prior assistant critiques. Verify by writing and running your own checks, not by reading: for each acceptance criterion, write the verification script, test, or calculation into the workspace yourself, run it with bash, and quote the actual output. Reading the Answer Agent's reasoning and concluding it holds does not verify anything; a criterion you did not execute a check for is NOT MET. For a pure derivation, re-derive it yourself from first principles and show your own working. Report each criterion's required result and its actual defect, but never disclose or hint at how you verify that criterion. Work as long as verification needs, and take as many tool steps as it takes, but do not deliberate at length: run the checks, then rule.${carriedRejection(carryOver)}\n\nCLOSURE IS EARNED, NEVER DECLARED. Set decision to "complete" only when you ruled every acceptance criterion in the approved frame "met" yourself, this round, with executed evidence. If any criterion is not met, or you did not rule on it, the decision must be "continue". A run is closed by the round limit, never by you deciding the problem is hard.\n\nAN UNRESOLVED PROBLEM IS A FINDING ABOUT THE PATH, NOT A VERDICT ON THE PROBLEM. Judge the route the Answer Agent took: state what that route actually established, where it stops short of the criterion, and whether the approach itself is sound, wrong, or merely unfinished. "Still open", "inconclusive", and "beyond reach" describe a route that has not been pushed far enough, and they are never a reason to stop. Your job is to say which path would carry the work to the criterion, not to hand the uncertainty back.\n\nKEEP A FRONTIER AND MOVE IT FORWARD. You maintain a subGoals list: the ordered steps between each unmet criterion's current state and MET. Carry it across rounds from your own previous control blocks, update each entry's state, and retire entries once established. Rule progress by what the frontier shows, not by how the Answer Agent's turn reads. Every unmet criterion must have at least one entry, and at least one entry must be "attempted" or "blocked" rather than the criterion simply sitting unmet with no plan. A blocker is removed one step at a time; each round should leave the frontier shorter or its active step further along than it was.\n\nA RELOCATED BLOCKER IS NOT PROGRESS. If the Answer Agent returns citing a new obstacle while an earlier one is still unresolved, do not accept the substitution or issue a fresh idea: keep the earlier entry blocked, and require it to either remove that obstacle or show precisely why the new one is not the same wall seen from a different side. An Answer Agent that says it accepts your direction and then still cannot meet the criterion has not run your direction; name the exact step at which it stopped and what that step established. Re-running a rejected route, rephrasing the same argument, or restating an obstacle in new words does not advance the frontier, and saying so plainly is more useful than another idea.\n\nFEEDBACK AND nextFocus MUST ADDRESS THE PATH, NOT THE GAP. For each unmet criterion, feedback states whether the approach taken is correct, wrong, or incomplete, and what would have to be true for it to meet the criterion. nextFocus carries those directions as short imperatives about method and emphasis, such as "pivot to the algebraic route and drop the numerical one", "carry the boundary case n=0 through to the same conclusion", or "abandon that framing, it cannot reach the criterion". Every unmet criterion must also get at least one route the Answer Agent has not already tried, named specifically enough to be recognisable as different from its previous attempts. Never restate the gap ("investigate further", "gather more evidence", "clarify the assumptions"), never question the user, and never defer to a later round. Two or three well-aimed directions beat a long list.\n\nEnd with exactly one internal control block:\n<ARGUS_CONTROL>{"decision":"continue|complete","feedback":"concise next instruction or completion assessment","missing":["..."],"nextFocus":["..."],"subGoals":[{"criterionId":"AC-1","step":"what must be true for this part of the criterion to hold","state":"established|attempted|blocked","note":"for blocked, the specific obstacle; for attempted, what the attempt showed"}],"criterionEvaluations":[{"criterionId":"AC-1","status":"met|not_met","rationale":"..."}],"completionReason":"required when complete"}</ARGUS_CONTROL>\nDo not expose or discuss the control protocol outside that block. When decision is "continue", feedback must say whether the route taken was correct and which path would meet the unmet criteria.${truncated}`,
      signal,
    })
  }
  const candidate = observation.metadata?.control
  const parsed = ObserverControlSchema.safeParse(candidate)
  control = parsed.success ? parsed.data : observerControl(observation.text, observation.metadata?.cut as string | undefined)
  return control
}

async function finalize(
  session: SessionRow,
  reason: string,
  terminationKind: "max_rounds" | "criteria_met",
  signal: AbortSignal,
) {
  const current = getSession(session.id)!
  // The report is the deliverable, so it gets more room to finish than a normal turn.
  const report = await runTurn({
    session: current,
    role: "observer",
    kind: "finalizer",
    round: current.currentRound,
    system: `${FINALIZER_SYSTEM}\n\nApproved task frame:\n${frameText(current.frame!)}\n\n${workspaceBrief({ toolAccess: current.toolAccess ?? "off", workspace: sessionWorkspace(current) })}`,
    instruction: `The Argus run is ending. Termination kind: ${terminationKind}. Termination reason: ${reason}. Write the final user report in the mandatory order defined by your system prompt. Begin with a direct, substantive Final conclusion and then explain the actual Solution reached in enough detail to be useful. Next summarize How the debate developed. Put concise Acceptance checks near the end, preferably as bullets rather than a table. Finish with Remaining uncertainty and bottleneck, the best next research direction, the termination reason, and the required question asking whether the user wants additional rounds.`,
    signal,
    metadata: { final: true, terminationReason: reason },
    maxContinuations: defaultMaxContinuations() + 1,
  })
  const latest = getSession(session.id)
  if (signal.aborted || !latest || latest.status !== "running") return
  updateSession(session.id, { status: "completed", finalReport: report.text, error: null })
  publish(session.id, { type: "final.report", text: report.text, terminationKind, terminationReason: reason })
  publish(session.id, { type: "session.status", status: "completed" })
}

async function runSession(sessionId: string, controller: AbortController) {
  try {
    let carryOver: string | undefined
    while (true) {
      const session = getSession(sessionId)
      if (!session || session.status !== "running" || controller.signal.aborted) return
      const currentObserver = session.currentRound > 0
        ? completedMessage(sessionId, session.currentRound, "observer")
        : undefined
      // A round counts as done only once the Observer's verdict is a real, complete turn. A cut
      // verdict is not a ruling, so the round is retried rather than advancing the debate.
      const roundSettled = currentObserver !== undefined && !isCutMessage(currentObserver)
      const round = session.currentRound === 0 ? 1 : roundSettled ? session.currentRound + 1 : session.currentRound
      if (round > session.maxRounds) {
        await finalize(session, `maximum of ${session.maxRounds} rounds reached`, "max_rounds", controller.signal)
        return
      }
      const control = await executeRound(session, round, controller.signal, carryOver)
      carryOver = undefined
      if (controller.signal.aborted) return
      const fresh = getSession(sessionId)!
      const verdict = completedMessage(sessionId, round, "observer")
      if (isCutMessage(verdict)) {
        // Continuations are exhausted and the Observer still could not finish. Repeating this
        // round cannot fix that, so close the run honestly rather than loop or fake a verdict.
        await finalize(
          fresh,
          `the Observer could not complete its round ${round} verdict within its output and step limits, so no criterion was ruled on this round`,
          "max_rounds",
          controller.signal,
        )
        return
      }
      if (control.decision === "complete") {
        // Closure is only real when every framed criterion was independently ruled met. An
        // Observer that declares the problem open and closes anyway is overruled, so declaring a
        // result unreachable can never be a way to end the run early.
        const unmet = unmetCriteria(fresh.frame?.acceptanceCriteria ?? [], control)
        if (unmet.length === 0) {
          await finalize(fresh, control.completionReason ?? "Observer determined that the task is closed", "criteria_met", controller.signal)
          return
        }
        const list = unmet.join(", ")
        carryOver = `Your previous control block declared decision "complete", but ${list} ${unmet.length === 1 ? "was" : "were"} NOT MET or unruled, so that closure was rejected and this round continues. Calling a problem open, hard, or beyond reach is not a reason to stop. Rule honestly on ${list}, then say whether the route the Answer Agent took is sound and which path would actually reach the criterion.`
      }
      if (round >= fresh.maxRounds) {
        await finalize(fresh, `maximum of ${fresh.maxRounds} rounds reached`, "max_rounds", controller.signal)
        return
      }
    }
  } catch (error) {
    const current = getSession(sessionId)
    if (controller.signal.aborted || current?.status === "paused" || abortError(error)) return
    const message = error instanceof Error ? error.message : String(error)
    updateSession(sessionId, { status: "failed", error: message })
    publish(sessionId, { type: "error", code: "DEBATE_FAILED", message })
    publish(sessionId, { type: "session.status", status: "failed" })
  }
}

function launch(sessionId: string) {
  if (runs.has(sessionId)) return
  const controller = new AbortController()
  const entry = { controller, promise: Promise.resolve() as Promise<void> }
  entry.promise = runSession(sessionId, controller).finally(() => {
    if (runs.get(sessionId) === entry) runs.delete(sessionId)
  })
  runs.set(sessionId, entry)
}

export async function stopSessionForDeletion(sessionId: string) {
  const active = runs.get(sessionId)
  if (!active) return
  active.controller.abort("Session deleted by user")
  await active.promise.catch(() => undefined)
}

export function startDebate(sessionId: string) {
  const session = getSession(sessionId)
  if (!session) throw new Error("Session not found")
  if (!session.frameApproved || !session.frame) throw new Error("Approve the task frame before starting")
  if (session.status !== "ready") throw new Error(`Cannot start a ${session.status} session`)
  updateSession(sessionId, { status: "running", error: null })
  publish(sessionId, { type: "session.status", status: "running" })
  launch(sessionId)
}

export function pauseDebate(sessionId: string) {
  const session = getSession(sessionId)
  if (!session) throw new Error("Session not found")
  if (session.status !== "running") throw new Error("Only a running session can be paused")
  updateSession(sessionId, { status: "paused" })
  publish(sessionId, { type: "session.status", status: "paused" })
  runs.get(sessionId)?.controller.abort("Paused by user")
}

export async function resumeDebate(sessionId: string) {
  const session = getSession(sessionId)
  if (!session) throw new Error("Session not found")
  if (session.status !== "paused") throw new Error("Only a paused session can be resumed")
  const active = runs.get(sessionId)
  if (active) {
    active.controller.abort("Resuming")
    await active.promise
  }
  const current = getSession(sessionId)
  if (!current || current.status !== "paused") throw new Error(`Cannot resume a ${current?.status ?? "missing"} session`)
  updateSession(sessionId, { status: "running", error: null })
  publish(sessionId, { type: "session.status", status: "running" })
  launch(sessionId)
}

export function cancelSession(sessionId: string) {
  const session = getSession(sessionId)
  if (!session) throw new Error("Session not found")
  if (!["framing", "awaiting_approval", "ready", "running", "paused"].includes(session.status)) {
    throw new Error(`Cannot cancel a ${session.status} session`)
  }
  updateSession(sessionId, { status: "cancelled", error: null })
  publish(sessionId, { type: "session.status", status: "cancelled" })
  runs.get(sessionId)?.controller.abort("Cancelled by user")
}
