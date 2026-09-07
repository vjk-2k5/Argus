import { z } from "zod"
import { JsonValueSchema } from "./common"
import { FrameSchema } from "./frame"

export const SessionStatusSchema = z.enum([
  "framing", "awaiting_approval", "ready", "running", "paused", "completed", "failed", "cancelled",
])
export type SessionStatus = z.infer<typeof SessionStatusSchema>
export const PartKindSchema = z.enum(["text", "reasoning"])
export type PartKind = z.infer<typeof PartKindSchema>

const TerminationKindSchema = z.enum(["criteria_met", "max_rounds"])

export const SessionEventDataSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.status"), status: SessionStatusSchema }),
  z.object({ type: z.literal("frame.updated"), frame: FrameSchema, approved: z.boolean() }),
  z.object({ type: z.literal("round.started"), round: z.number().int().positive() }),
  z.object({
    type: z.literal("message.started"),
    messageId: z.string(),
    role: z.enum(["framer", "answerer", "observer"]),
    round: z.number().int().nonnegative(),
    metadata: z.record(z.string(), JsonValueSchema).optional(),
  }),
  z.object({ type: z.literal("part.delta"), messageId: z.string(), partId: z.string(), kind: PartKindSchema, delta: z.string() }),
  z.object({ type: z.literal("message.completed"), messageId: z.string() }),
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
