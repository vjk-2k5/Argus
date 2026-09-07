import { z } from "zod"

export const CriterionEvaluationSchema = z.object({
  criterionId: z.string().min(1),
  status: z.enum(["met", "not_met"]),
  rationale: z.string().min(1),
})
export type CriterionEvaluation = z.infer<typeof CriterionEvaluationSchema>

export const ObserverControlSchema = z.object({
  decision: z.enum(["continue", "complete"]),
  feedback: z.string().min(1),
  missing: z.array(z.string()).default([]),
  nextFocus: z.array(z.string()).default([]),
  criterionEvaluations: z.array(CriterionEvaluationSchema),
  completionReason: z.string().min(1).optional(),
}).superRefine((control, context) => {
  if (control.decision === "complete" && !control.completionReason?.trim()) {
    context.addIssue({
      code: "custom",
      path: ["completionReason"],
      message: "completionReason is required when decision is complete",
    })
  }
})
export type ObserverControl = z.infer<typeof ObserverControlSchema>

export const ClaimCheckSchema = z.object({
  claim: z.string(),
  status: z.enum(["supported", "uncertain", "unsupported"]),
  rationale: z.string(),
})

export const ObserverReportSchema = z.object({
  verdict: z.enum(["resolved", "partially_resolved", "open"]),
  summary: z.string().min(1),
  strengths: z.array(z.string()),
  unresolved: z.array(z.string()),
  claimChecks: z.array(ClaimCheckSchema),
  recommendedNextSteps: z.array(z.string()),
})
export type ObserverReport = z.infer<typeof ObserverReportSchema>
