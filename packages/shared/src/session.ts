import { z } from "zod"
import { JsonValueSchema, RoleConfigsSchema } from "./common"
import { PartKindSchema, SessionStatusSchema } from "./events"

export const CreateSessionSchema = z.object({
  problem: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  roles: RoleConfigsSchema,
  maxRounds: z.number().int().min(1).max(20).default(6),
})
export type CreateSessionInput = z.infer<typeof CreateSessionSchema>

export const MessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: z.enum(["user", "framer", "answerer", "observer", "system"]),
  round: z.number().int().nonnegative(),
  status: z.enum(["streaming", "completed", "aborted", "failed"]),
  text: z.string(),
  reasoning: z.string(),
  metadata: JsonValueSchema.optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
})
export type Message = z.infer<typeof MessageSchema>

export const SessionSummarySchema = z.object({
  id: z.string(), problem: z.string(), title: z.string(), status: SessionStatusSchema,
  currentRound: z.number(), maxRounds: z.number(), createdAt: z.string(), updatedAt: z.string(),
})
