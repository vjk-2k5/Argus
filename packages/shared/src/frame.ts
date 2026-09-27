import { z } from "zod"

export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  verification: z.string().min(1),
})

export const FrameSchema = z.object({
  title: z.string().min(1).max(200),
  restatedProblem: z.string().min(1),
  objective: z.string().min(1),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1).max(6),
  evidenceStandard: z.string().min(1),
  maxRounds: z.number().int().min(1),
}).superRefine((frame, context) => {
  const seen = new Set<string>()
  frame.acceptanceCriteria.forEach((criterion, index) => {
    if (seen.has(criterion.id)) {
      context.addIssue({
        code: "custom",
        path: ["acceptanceCriteria", index, "id"],
        message: `Duplicate acceptance criterion ID: ${criterion.id}`,
      })
    }
    seen.add(criterion.id)
  })
})
export type Frame = z.infer<typeof FrameSchema>

export const FrameUpdateSchema = FrameSchema
export const FrameApprovalSchema = z.object({ approved: z.literal(true) })
