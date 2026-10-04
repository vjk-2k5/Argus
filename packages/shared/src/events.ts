import { z } from "zod"
import { JsonValueSchema } from "./common"
import { FrameSchema } from "./frame"
import { ToolAccessSchema, ToolInvocationSchema } from "./tools"

export const SessionStatusSchema = z.enum([
  "framing", "awaiting_approval", "ready", "running", "paused", "completed", "failed", "cancelled",
])
export type SessionStatus = z.infer<typeof SessionStatusSchema>
export const PartKindSchema = z.enum(["text", "reasoning", "tool"])
export type PartKind = z.infer<typeof PartKindSchema>

/**
 * One contiguous piece of an agent turn. A turn is a list of parts in the order the model
 * produced them, so reasoning, tool calls, and prose interleave exactly as they happened.
 */
export const PartSchema = z.object({
  id: z.string(),
  kind: PartKindSchema,
  text: z.string().default(""),
  toolId: z.string().optional(),
})
export type Part = z.infer<typeof PartSchema>

/** Parts of a message, oldest first. Stored in the message metadata so a reload keeps order. */
export const PartsSchema = z.array(PartSchema)

/** Why a turn ended before the agent finished: an output cap, the step cap, or a hard stop. */
export const CutReasonSchema = z.enum(["length", "steps", "content-filter", "error"])
export type CutReason = z.infer<typeof CutReasonSchema>

const TerminationKindSchema = z.enum(["criteria_met", "max_rounds"])

export const SessionEventDataSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.status"), status: SessionStatusSchema }),
  z.object({ type: z.literal("session.tools"), toolAccess: ToolAccessSchema, workspace: z.string() }),
  z.object({ type: z.literal("frame.updated"), frame: FrameSchema, approved: z.boolean() }),
  z.object({ type: z.literal("round.started"), round: z.number().int().positive() }),
  z.object({
    type: z.literal("message.started"),
    messageId: z.string(),
    role: z.enum(["framer", "answerer", "observer"]),
    round: z.number().int().nonnegative(),
    metadata: z.record(z.string(), JsonValueSchema).optional(),
  }),
  z.object({ type: z.literal("part.started"), messageId: z.string(), partId: z.string(), kind: PartKindSchema }),
  z.object({ type: z.literal("part.delta"), messageId: z.string(), partId: z.string(), kind: PartKindSchema, delta: z.string() }),
  z.object({ type: z.literal("part.completed"), messageId: z.string(), partId: z.string() }),
  z.object({ type: z.literal("message.completed"), messageId: z.string() }),
  z.object({
    type: z.literal("turn.cut"),
    messageId: z.string(),
    round: z.number().int().nonnegative(),
    reason: CutReasonSchema,
  }),
  z.object({
    type: z.literal("turn.continued"),
    messageId: z.string(),
    round: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
  }),
  z.object({ type: z.literal("tool.updated"), messageId: z.string(), tool: ToolInvocationSchema }),
  z.object({ type: z.literal("question.asked"), messageId: z.string(), question: z.string(), options: z.array(z.string()) }),
  z.object({ type: z.literal("compaction.created"), id: z.string(), summary: z.string() }),
  z.object({ type: z.literal("usage.updated"), inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number() }),
  z.object({
    type: z.literal("final.report"),
    text: z.string(),
    terminationKind: TerminationKindSchema,
    terminationReason: z.string(),
  }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
])

export const SseEventEnvelopeSchema = z.object({
  id: z.string(), sessionId: z.string(), at: z.string().datetime(), event: SessionEventDataSchema,
})
export type SessionEventData = z.infer<typeof SessionEventDataSchema>
export type SseEventEnvelope = z.infer<typeof SseEventEnvelopeSchema>
