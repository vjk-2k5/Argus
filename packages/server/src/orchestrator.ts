import { generateText, streamText, type ModelMessage } from "ai"
import {
  FrameSchema,
  ObserverControlSchema,
  type Frame,
  type ObserverControl,
  type RoleModelConfig,
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
import { ANSWERER_SYSTEM, FINALIZER_SYSTEM, FRAMER_SYSTEM, OBSERVER_SYSTEM, framePrompt, frameText } from "./prompts"

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

const DEFAULT_MAX_OUTPUT_TOKENS = 8_192
const MIN_MAX_OUTPUT_TOKENS = 256
const MAX_MAX_OUTPUT_TOKENS = 65_536

function defaultMaxOutputTokens() {
  const value = Number(process.env.ARGUS_MAX_OUTPUT_TOKENS ?? DEFAULT_MAX_OUTPUT_TOKENS)
  return Number.isInteger(value) && value >= MIN_MAX_OUTPUT_TOKENS && value <= MAX_MAX_OUTPUT_TOKENS
    ? value
    : DEFAULT_MAX_OUTPUT_TOKENS
}

function modelOptions(config: RoleModelConfig) {
  const options = { ...config.options } as Record<string, unknown>
  const configured = options.maxOutputTokens
  const requested = typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? configured
    : defaultMaxOutputTokens()
  const discovered = providerMaxOutputTokens(config)
  return {
    ...options,
    maxOutputTokens: discovered ? Math.min(requested, discovered) : requested,
  }
}

async function runFraming(sessionId: string, controller: AbortController) {
  const session = getSession(sessionId)
  if (!session || session.status !== "framing") return
  try {
    const message = await streamAgent({
      session,
      role: "framer",
      round: 0,
      model: session.roles.framer,
      system: FRAMER_SYSTEM,
      messages: [{ role: "user", content: framePrompt(session.problem, session.maxRounds) }],
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
  let rawText = ""
  let text = ""
  let reasoning = ""
  try {
    const result = streamText({
      ...modelOptions(input.model),
      model: resolveModel(input.model),
      system: input.system,
      messages: input.messages,
      abortSignal: input.signal,
    } as any)

    for await (const event of result.fullStream) {
      const value = event as unknown as Record<string, unknown>
      if (event.type === "text-delta") {
        const delta = String(value.text ?? value.textDelta ?? "")
        rawText += delta
        const visible = visibleStreamText(rawText, input.stripControl === true, false)
        const visibleDelta = visible.slice(text.length)
        text = visible
        updateMessage(message.id, { text })
        if (visibleDelta) {
          publish(input.session.id, { type: "part.delta", messageId: message.id, partId: `${message.id}:text`, kind: "text", delta: visibleDelta })
        }
      } else if (event.type === "reasoning-delta") {
        const delta = String(value.text ?? value.textDelta ?? "")
        reasoning += delta
        updateMessage(message.id, { reasoning })
        publish(input.session.id, { type: "part.delta", messageId: message.id, partId: `${message.id}:reasoning`, kind: "reasoning", delta })
      } else if (event.type === "error") {
        throw value.error ?? new Error("Model stream failed")
      }
    }
    const finalText = input.stripControl ? cleanObserverText(rawText) : rawText
    const finalDelta = finalText.slice(text.length)
    text = finalText
    if (finalDelta) {
      publish(input.session.id, { type: "part.delta", messageId: message.id, partId: `${message.id}:text`, kind: "text", delta: finalDelta })
    }
    const streamResult = result as unknown as { totalUsage?: Promise<unknown>; usage?: Promise<unknown> }
    const totals = usage(await (streamResult.totalUsage ?? streamResult.usage ?? Promise.resolve(undefined)))
    const metadata = input.stripControl
      ? { ...input.metadata, control: observerControl(rawText) }
      : input.metadata
    const completed = completeMessage(message.id, {
      status: "completed",
      text,
      reasoning,
      ...(metadata ? { metadata } : {}),
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
    completeMessage(message.id, {
      status: aborted ? "aborted" : "failed",
      text,
      reasoning,
      metadata: { ...input.metadata, error: error instanceof Error ? error.message : String(error) },
    })
    throw error
  }
}

function transcript(messages: MessageRow[]) {
  return messages
    .filter((message: MessageRow) => message.status === "completed" && (message.role === "answerer" || message.role === "observer") && message.metadata?.final !== true)
    .map((message: MessageRow) => `[Round ${message.round} · ${message.role}]\n${message.text}`)
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
    system: "You compact Argus debate state. Preserve hypotheses, derivations, counterexamples, claim qualifications, observer objections, acceptance-criteria progress, and unresolved bottlenecks. Preserve provenance: any citation, paper, URL, external verification, experiment, code run, simulation, Monte Carlo result, or peer-review claim not explicitly supplied by the user must remain marked unverified or unperformed. Never invent, complete, repair, or validate bibliographic details or links, and never convert a proposed check into a completed result.",
    prompt: `Previous summary:\n${state.summary || "None"}\n\nConversation to compact:\n${source}\n\nWrite a dense continuation summary for both agents. Keep all unsupported external claims explicitly unverified and all proposed executions explicitly unperformed.`,
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
      : `\n\n[Observer control guidance]\n${JSON.stringify(control, null, 2)}`
  return `[${label} · Round ${message.round}]\n${message.text}${controlText}`
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

function observerControl(text: string): ObserverControl {
  const match = text.match(CONTROL)
  if (!match?.[1]) {
    return {
      decision: "continue",
      feedback: cleanObserverText(text) || "Continue with a materially different attack.",
      missing: text.toLowerCase().includes(CONTROL_OPEN.toLowerCase()) ? ["Observer control block was invalid"] : [],
      nextFocus: [],
      criterionEvaluations: [],
    }
  }
  try {
    return ObserverControlSchema.parse(JSON.parse(match[1]))
  } catch {
    return {
      decision: "continue",
      feedback: cleanObserverText(text) || "Continue with a materially different attack.",
      missing: ["Observer control block was invalid"],
      nextFocus: [],
      criterionEvaluations: [],
    }
  }
}

function cleanObserverText(text: string) {
  const controlAt = text.toLowerCase().indexOf(CONTROL_OPEN.toLowerCase())
  return (controlAt >= 0 ? text.slice(0, controlAt) : text.replace(CONTROL, "")).trim()
}

async function executeRound(session: SessionRow, round: number, signal: AbortSignal) {
  const active = getSession(session.id)
  if (!active || active.status !== "running" || signal.aborted) throw new DOMException("Stopped", "AbortError")
  updateSession(session.id, { currentRound: round, status: "running" })
  publish(session.id, { type: "round.started", round })

  let answer = completedMessage(session.id, round, "answerer")
  if (!answer) {
    const current = getSession(session.id)!
    const messages = await agentConversation(
      current,
      "answerer",
      `Produce the Round ${round} candidate solution. Continue from your own prior assistant turns rather than restarting. Drive the problem toward complete closure, address every acceptance criterion, and act on every Observer critique and control instruction. If a prior approach failed, change or deepen the approach rather than stopping at an uncertainty or bottleneck.`,
      signal,
    )
    answer = await streamAgent({
      session: current,
      role: "answerer",
      round,
      model: current.roles.answerer,
      system: `${ANSWERER_SYSTEM}\n\nApproved task frame:\n${frameText(current.frame!)}`,
      messages,
      signal,
    })
  }
  if (signal.aborted) throw new DOMException("Paused", "AbortError")

  let observation = completedMessage(session.id, round, "observer")
  let control: ObserverControl
  if (!observation) {
    const current = getSession(session.id)!
    const messages = await agentConversation(
      current,
      "observer",
      `Independently verify the Answer Agent's Round ${round} candidate now present in the conversation and continue from your own prior assistant critiques. Check every acceptance criterion, identify the earliest concrete defect or missing proof, and direct the next attempt toward the strongest path to closure. If work remains, give specific corrective feedback rather than a final report or user continuation question. End with exactly one internal control block:\n<ARGUS_CONTROL>{"decision":"continue|complete","feedback":"concise next instruction or completion assessment","missing":["..."],"nextFocus":["..."],"criterionEvaluations":[{"criterionId":"AC-1","status":"met|not_met","rationale":"..."}],"completionReason":"required when complete"}</ARGUS_CONTROL>\nDo not expose or discuss the control protocol outside that block.`,
      signal,
    )
    observation = await streamAgent({
      session: current,
      role: "observer",
      round,
      model: current.roles.observer,
      system: `${OBSERVER_SYSTEM}\n\nApproved task frame:\n${frameText(current.frame!)}`,
      messages,
      signal,
      stripControl: true,
    })
  }
  const candidate = observation.metadata?.control
  const parsed = ObserverControlSchema.safeParse(candidate)
  control = parsed.success ? parsed.data : observerControl(observation.text)
  return control
}

async function finalize(
  session: SessionRow,
  reason: string,
  terminationKind: "max_rounds" | "criteria_met",
  signal: AbortSignal,
) {
  const current = getSession(session.id)!
  const messages = await agentConversation(
    current,
    "observer",
    `The Argus run is ending. Termination kind: ${terminationKind}. Termination reason: ${reason}. Write the final user report in the mandatory order defined by your system prompt. Begin with a direct, substantive Final conclusion and then explain the actual Solution reached in enough detail to be useful. Next summarize How the debate developed. Put concise Acceptance checks near the end, preferably as bullets rather than a table. Finish with Remaining uncertainty and bottleneck, the best next research direction, the termination reason, and the required question asking whether the user wants additional rounds.`,
    signal,
  )
  const report = await streamAgent({
    session: current,
    role: "observer",
    round: current.currentRound,
    model: current.roles.observer,
    system: `${FINALIZER_SYSTEM}\n\nApproved task frame:\n${frameText(current.frame!)}`,
    messages,
    signal,
    metadata: { final: true, terminationReason: reason },
  })
  const latest = getSession(session.id)
  if (signal.aborted || !latest || latest.status !== "running") return
  updateSession(session.id, { status: "completed", finalReport: report.text, error: null })
  publish(session.id, { type: "final.report", text: report.text, terminationKind, terminationReason: reason })
  publish(session.id, { type: "session.status", status: "completed" })
}

async function runSession(sessionId: string, controller: AbortController) {
  try {
    while (true) {
      const session = getSession(sessionId)
      if (!session || session.status !== "running" || controller.signal.aborted) return
      const currentObserver = session.currentRound > 0
        ? completedMessage(sessionId, session.currentRound, "observer")
        : undefined
      const round = session.currentRound === 0 ? 1 : currentObserver ? session.currentRound + 1 : session.currentRound
      if (round > session.maxRounds) {
        await finalize(session, `maximum of ${session.maxRounds} rounds reached`, "max_rounds", controller.signal)
        return
      }
      const control = await executeRound(session, round, controller.signal)
      if (controller.signal.aborted) return
      const fresh = getSession(sessionId)!
      if (control.decision === "complete") {
        await finalize(fresh, control.completionReason ?? "Observer determined that the task is closed", "criteria_met", controller.signal)
        return
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
