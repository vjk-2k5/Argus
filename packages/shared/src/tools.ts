import { z } from "zod"
import { JsonValueSchema } from "./common"

export const ToolNameSchema = z.enum([
  "read",
  "write",
  "edit",
  "apply_patch",
  "glob",
  "grep",
  "list",
  "bash",
  "websearch",
  "webfetch",
  "question",
])
export type ToolName = z.infer<typeof ToolNameSchema>

/** `off` disables tools entirely, `read` allows observation only, `full` allows mutation. */
export const ToolAccessSchema = z.enum(["off", "read", "full"])
export type ToolAccess = z.infer<typeof ToolAccessSchema>

export const ToolInvocationStateSchema = z.enum(["pending", "running", "completed", "failed"])
export type ToolInvocationState = z.infer<typeof ToolInvocationStateSchema>

export const ToolInvocationSchema = z.object({
  id: z.string(),
  name: ToolNameSchema,
  state: ToolInvocationStateSchema,
  arguments: z.record(z.string(), JsonValueSchema).default({}),
  title: z.string().default(""),
  output: z.string().default(""),
  error: z.string().optional(),
  startedAt: z.number().int().nonnegative().default(0),
  endedAt: z.number().int().nonnegative().optional(),
})
export type ToolInvocation = z.infer<typeof ToolInvocationSchema>

export const ToolDescriptorSchema = z.object({
  name: ToolNameSchema,
  description: z.string(),
  access: z.enum(["read", "full"]),
  mutating: z.boolean(),
})
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>

export const ToolCatalogSchema = z.object({
  tools: z.array(ToolDescriptorSchema),
  sessionsRoot: z.string(),
  shell: z.string(),
})
export type ToolCatalog = z.infer<typeof ToolCatalogSchema>
