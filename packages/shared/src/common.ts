import { z } from "zod"

export const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
)
export type JsonValue = z.infer<typeof JsonValueSchema>

export const ProviderIdSchema = z.enum(["openai", "anthropic", "google", "openrouter", "openai-compatible"])
export type ProviderId = z.infer<typeof ProviderIdSchema>

export const RoleModelConfigSchema = z.object({
  providerID: ProviderIdSchema,
  modelID: z.string().min(1),
  options: z.record(z.string(), JsonValueSchema).default({}),
})
export type RoleModelConfig = z.infer<typeof RoleModelConfigSchema>

export const RoleConfigsSchema = z.object({
  framer: RoleModelConfigSchema,
  answerer: RoleModelConfigSchema,
  observer: RoleModelConfigSchema,
})
export type RoleConfigs = z.infer<typeof RoleConfigsSchema>
