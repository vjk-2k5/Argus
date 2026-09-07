import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { ProviderId, RoleConfigs, RoleModelConfig } from "@argus/shared"
import {
  credentialSource,
  hasProviderCredential,
  isKnownProviderId,
  withProviderCredential,
  type CredentialSource,
} from "./credential-store"

export type ModelSource = "api" | "fallback"

export interface ModelMetadata {
  id: string
  name?: string
  contextWindow?: number
  maxOutputTokens?: number
}

export type ModelMetadataRecord = Record<string, ModelMetadata>

export interface ProviderView {
  id: ProviderId
  name: string
  models: string[]
  modelMetadata: ModelMetadataRecord
  defaultModelID: string
  configured: boolean
  credentialSource: CredentialSource
  modelSource: ModelSource
  modelError?: string
}

interface ProviderDefinition {
  id: ProviderId
  name: string
  defaultModelID: string
  fallbackModels: string[]
  modelsEnv: string
}

const definitions: ProviderDefinition[] = [
  { id: "openai", name: "OpenAI", defaultModelID: "gpt-5", fallbackModels: ["gpt-5", "gpt-4.1"], modelsEnv: "ARGUS_OPENAI_MODELS" },
  { id: "anthropic", name: "Anthropic", defaultModelID: "claude-sonnet-4-5", fallbackModels: ["claude-sonnet-4-5", "claude-opus-4-1"], modelsEnv: "ARGUS_ANTHROPIC_MODELS" },
  { id: "google", name: "Google AI Studio", defaultModelID: "gemini-2.5-pro", fallbackModels: ["gemini-2.5-pro", "gemini-2.5-flash"], modelsEnv: "ARGUS_GOOGLE_MODELS" },
  { id: "openrouter", name: "OpenRouter", defaultModelID: "openai/gpt-5", fallbackModels: ["openai/gpt-5", "anthropic/claude-sonnet-4.5"], modelsEnv: "ARGUS_OPENROUTER_MODELS" },
  { id: "openai-compatible", name: "OpenAI compatible", defaultModelID: "default", fallbackModels: ["default"], modelsEnv: "ARGUS_OPENAI_COMPATIBLE_MODELS" },
]

const cacheLifetimeMs = 5 * 60 * 1000

export const isProviderId = isKnownProviderId

function fallbackModels(definition: ProviderDefinition) {
  const override = process.env[definition.modelsEnv]?.split(",").map((model) => model.trim()).filter(Boolean)
  return [...new Set(override?.length ? override : definition.fallbackModels)]
}
function uniqueSorted(models: string[]) {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))
}

function positiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function optionalName(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function metadataRecord(models: string[], metadata: ModelMetadata[] = []): ModelMetadataRecord {
  const byId = new Map(metadata.map((item) => [item.id, item]))
  return Object.fromEntries(models.map((id) => [id, byId.get(id) ?? { id }]))
}

interface DiscoveredModels {
  models: string[]
  modelMetadata: ModelMetadataRecord
}

async function fetchJson(url: string, headers: Record<string, string>, providerName: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new Error(`${providerName} model discovery request failed`)
  }
  if (!response.ok) throw new Error(`${providerName} model discovery failed (HTTP ${response.status})`)
  try {
    return await response.json()
  } catch {
    throw new Error(`${providerName} model discovery returned invalid JSON`)
  }
}

async function discoverOpenRouter(key: string): Promise<DiscoveredModels> {
  const body = await fetchJson(
    "https://openrouter.ai/api/v1/models",
    { Authorization: `Bearer ${key}` },
    "OpenRouter",
  )
  const data = body && typeof body === "object" ? (body as Record<string, unknown>).data : undefined
  if (!Array.isArray(data)) throw new Error("OpenRouter model discovery returned an invalid response")
  const metadata = data.flatMap((item): ModelMetadata[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return []
    const model = item as Record<string, unknown>
    const architecture = model.architecture
    if (architecture && typeof architecture === "object" && !Array.isArray(architecture)) {
      const outputModalities = (architecture as Record<string, unknown>).output_modalities
      if (outputModalities !== undefined && (!Array.isArray(outputModalities) || !outputModalities.includes("text"))) return []
    }
    const id = typeof model.id === "string" ? model.id.trim() : ""
    if (!id) return []
    const topProvider = model.top_provider
    const maxOutputTokens = topProvider && typeof topProvider === "object" && !Array.isArray(topProvider)
      ? positiveNumber((topProvider as Record<string, unknown>).max_completion_tokens)
      : undefined
    const name = optionalName(model.name)
    const contextWindow = positiveNumber(model.context_length)
    return [{
      id,
      ...(name ? { name } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    }]
  })
  const models = uniqueSorted(metadata.map((model) => model.id))
  if (!models.length) throw new Error("OpenRouter model discovery returned no text-output models")
  return { models, modelMetadata: metadataRecord(models, metadata) }
}

async function discoverGoogle(key: string): Promise<DiscoveredModels> {
  const metadata: ModelMetadata[] = []
  const seenTokens = new Set<string>()
  let pageToken: string | undefined

  for (let page = 0; page < 100; page++) {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models")
    if (pageToken) url.searchParams.set("pageToken", pageToken)
    const body = await fetchJson(url.toString(), { "x-goog-api-key": key }, "Google AI Studio")
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Google AI Studio model discovery returned an invalid response")
    }
    const record = body as Record<string, unknown>
    if (record.models !== undefined && !Array.isArray(record.models)) {
      throw new Error("Google AI Studio model discovery returned an invalid model list")
    }
    for (const item of (record.models as unknown[] | undefined) ?? []) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue
      const model = item as Record<string, unknown>
      if (!Array.isArray(model.supportedGenerationMethods) || !model.supportedGenerationMethods.includes("generateContent")) continue
      const id = typeof model.name === "string" ? model.name.replace(/^models\//, "").trim() : ""
      if (!id) continue
      const name = optionalName(model.displayName)
      const contextWindow = positiveNumber(model.inputTokenLimit)
      const maxOutputTokens = positiveNumber(model.outputTokenLimit)
      metadata.push({
        id,
        ...(name ? { name } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
      })
    }
    const next = record.nextPageToken
    if (next === undefined || next === null || next === "") {
      pageToken = undefined
      break
    }
    if (typeof next !== "string" || seenTokens.has(next)) {
      throw new Error("Google AI Studio model discovery returned invalid pagination")
    }
    seenTokens.add(next)
    pageToken = next
  }

  if (pageToken) throw new Error("Google AI Studio model discovery exceeded the pagination limit")
  const models = uniqueSorted(metadata.map((model) => model.id))
  if (!models.length) throw new Error("Google AI Studio model discovery returned no generateContent models")
  return { models, modelMetadata: metadataRecord(models, metadata) }
}

async function discoverWithKey(id: "openrouter" | "google", key: string) {
  return id === "openrouter" ? discoverOpenRouter(key) : discoverGoogle(key)
}

interface DiscoveryResult extends DiscoveredModels {
  modelSource: ModelSource
  modelError?: string
}

interface CacheEntry extends DiscoveryResult {
  expiresAt: number
}

const discoveryCache = new Map<ProviderId, CacheEntry>()

export function invalidateProviderCache(id?: ProviderId) {
  if (id) discoveryCache.delete(id)
  else discoveryCache.clear()
}

export async function verifyProviderCredential(id: ProviderId, key: string) {
  if (id === "openrouter" || id === "google") await discoverWithKey(id, key)
}

async function discover(definition: ProviderDefinition, force: boolean): Promise<DiscoveryResult> {
  const fallback = fallbackModels(definition)
  const fallbackMetadata = metadataRecord(fallback)
  if (definition.id !== "openrouter" && definition.id !== "google") {
    return { models: fallback, modelMetadata: fallbackMetadata, modelSource: "fallback" }
  }
  if (!hasProviderCredential(definition.id)) {
    return { models: fallback, modelMetadata: fallbackMetadata, modelSource: "fallback" }
  }

  const cached = discoveryCache.get(definition.id)
  if (!force && cached && cached.expiresAt > Date.now()) {
    const { expiresAt: _, ...result } = cached
    return result
  }

  try {
    const pending = withProviderCredential(definition.id, (key) => discoverWithKey(definition.id as "openrouter" | "google", key))
    if (!pending) return { models: fallback, modelMetadata: fallbackMetadata, modelSource: "fallback" }
    const discovered = await pending
    const result: DiscoveryResult = { ...discovered, modelSource: "api" }
    discoveryCache.set(definition.id, { ...result, expiresAt: Date.now() + cacheLifetimeMs })
    return result
  } catch (cause) {
    const modelError = cause instanceof Error ? cause.message : `${definition.name} model discovery failed`
    const result: DiscoveryResult = cached?.modelSource === "api"
      ? { models: cached.models, modelMetadata: cached.modelMetadata, modelSource: "api", modelError }
      : { models: fallback, modelMetadata: fallbackMetadata, modelSource: "fallback", modelError }
    discoveryCache.set(definition.id, { ...result, expiresAt: Date.now() + cacheLifetimeMs })
    return result
  }
}
async function providerView(definition: ProviderDefinition, force: boolean): Promise<ProviderView> {
  const discovered = await discover(definition, force)
  const defaultModelID = discovered.models.includes(definition.defaultModelID)
    ? definition.defaultModelID
    : discovered.models[0] ?? definition.defaultModelID
  const configured = definition.id === "openai-compatible"
    ? hasProviderCredential(definition.id) && Boolean(process.env.ARGUS_OPENAI_COMPATIBLE_BASE_URL?.trim())
    : hasProviderCredential(definition.id)
  return {
    id: definition.id,
    name: definition.name,
    models: discovered.models,
    modelMetadata: discovered.modelMetadata,
    defaultModelID,
    configured,
    credentialSource: credentialSource(definition.id),
    modelSource: discovered.modelSource,
    ...(discovered.modelError ? { modelError: discovered.modelError } : {}),
  }
}

export interface ProviderViewOptions {
  refresh?: boolean | ProviderId
}

export async function providerViews(options: ProviderViewOptions = {}) {
  return Promise.all(definitions.map((definition) => providerView(
    definition,
    options.refresh === true || options.refresh === definition.id,
  )))
}

export function providerDefaults(views: ProviderView[]): RoleConfigs {
  const first = views.find((provider) => provider.configured) ?? views[0]!
  const model = (): RoleModelConfig => ({
    providerID: first.id,
    modelID: first.defaultModelID,
    options: {},
  })
  return { framer: model(), answerer: model(), observer: model() }
}

function requireProviderCredential<T>(id: ProviderId, name: string, use: (key: string) => T) {
  const result = withProviderCredential(id, use)
  if (result === undefined) throw new Error(`${name} is not configured on the Argus server`)
  return result
}

export function resolveModel(config: RoleModelConfig): any {
  switch (config.providerID) {
    case "openai":
      return requireProviderCredential("openai", "OPENAI_API_KEY", (apiKey) => createOpenAI({ apiKey })(config.modelID))
    case "anthropic":
      return requireProviderCredential("anthropic", "ANTHROPIC_API_KEY", (apiKey) => createAnthropic({ apiKey })(config.modelID))
    case "google":
      return requireProviderCredential("google", "GOOGLE_GENERATIVE_AI_API_KEY", (apiKey) => createGoogleGenerativeAI({ apiKey })(config.modelID))
    case "openrouter":
      return requireProviderCredential("openrouter", "OPENROUTER_API_KEY", (apiKey) => createOpenAICompatible({
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey,
        headers: { "HTTP-Referer": "http://localhost", "X-Title": "Argus" },
      })(config.modelID))
    case "openai-compatible":
      return requireProviderCredential("openai-compatible", "ARGUS_OPENAI_COMPATIBLE_API_KEY", (apiKey) => createOpenAICompatible({
        name: "argus-compatible",
        baseURL: requireValue(process.env.ARGUS_OPENAI_COMPATIBLE_BASE_URL, "ARGUS_OPENAI_COMPATIBLE_BASE_URL"),
        apiKey,
      })(config.modelID))
  }
}

function requireValue(value: string | undefined, name: string) {
  if (!value?.trim()) throw new Error(`${name} is not configured on the Argus server`)
  return value.trim()
}

function defaultContextWindow() {
  const value = Number(process.env.ARGUS_CONTEXT_WINDOW ?? 128_000)
  return Number.isFinite(value) && value > 0 ? value : 128_000
}

export function maxOutputTokens(config: RoleModelConfig) {
  return positiveNumber(discoveryCache.get(config.providerID)?.modelMetadata[config.modelID]?.maxOutputTokens)
}

export function contextWindow(config: RoleModelConfig) {
  const discovered = discoveryCache.get(config.providerID)?.modelMetadata[config.modelID]?.contextWindow
  return positiveNumber(discovered) ?? defaultContextWindow()
}
