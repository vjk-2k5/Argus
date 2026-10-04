import { z } from "zod"

export const CriterionEvaluationSchema = z.object({
  criterionId: z.string().min(1),
  status: z.enum(["met", "not_met"]),
  rationale: z.string().min(1),
})
export type CriterionEvaluation = z.infer<typeof CriterionEvaluationSchema>

/**
 * One step on the path between a criterion's current state and MET. The Observer carries this list
 * across rounds so progress is cumulative: a blocker gets removed one step at a time instead of
 * being replaced by a fresh obstacle each round.
 */
export const SubGoalSchema = z.object({
  criterionId: z.string().min(1),
  step: z.string().min(1).describe("What must be true for this part of the criterion to hold."),
  state: z.enum(["established", "attempted", "blocked"]),
  note: z.string().optional().describe("For blocked: the specific obstacle. For attempted: what the attempt showed."),
})
export type SubGoal = z.infer<typeof SubGoalSchema>

export const ObserverControlSchema = z.object({
  decision: z.enum(["continue", "complete"]),
  feedback: z.string().min(1),
  missing: z.array(z.string()).default([]),
  nextFocus: z.array(z.string()).default([]),
  subGoals: z.array(SubGoalSchema).default([]),
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
  // Continuing on an unmet criterion means work remains, so the Observer must say what the work
  // is. Without a frontier the next round restarts from nothing and relocates the blocker instead
  // of removing it.
  const unmet = control.criterionEvaluations.some((entry) => entry.status === "not_met")
  if (control.decision === "continue" && unmet && control.subGoals.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["subGoals"],
      message: "subGoals is required when continuing with an unmet criterion",
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
