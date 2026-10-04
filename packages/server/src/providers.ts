import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
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
  /** A single model chosen by an environment variable, taking precedence over `defaultModelID`. */
  defaultModelEnv?: string
  /** Extra environment variable this provider needs alongside its credential before it can be used. */
  requiresEnv?: string
}

const definitions: ProviderDefinition[] = [
  { id: "openai", name: "OpenAI", defaultModelID: "gpt-5", fallbackModels: ["gpt-5", "gpt-4.1"], modelsEnv: "ARGUS_OPENAI_MODELS" },
  { id: "anthropic", name: "Anthropic", defaultModelID: "claude-sonnet-4-5", fallbackModels: ["claude-sonnet-4-5", "claude-opus-4-1"], modelsEnv: "ARGUS_ANTHROPIC_MODELS" },
  { id: "google", name: "Google AI Studio", defaultModelID: "gemini-2.5-pro", fallbackModels: ["gemini-2.5-pro", "gemini-2.5-flash"], modelsEnv: "ARGUS_GOOGLE_MODELS" },
  { id: "openrouter", name: "OpenRouter", defaultModelID: "openai/gpt-5", fallbackModels: ["openai/gpt-5", "anthropic/claude-sonnet-4.5"], modelsEnv: "ARGUS_OPENROUTER_MODELS" },
  { id: "openai-compatible", name: "OpenAI compatible", defaultModelID: "default", fallbackModels: ["default"], modelsEnv: "ARGUS_OPENAI_COMPATIBLE_MODELS", requiresEnv: "ARGUS_OPENAI_COMPATIBLE_BASE_URL" },
  {
    id: "bedrock",
    name: "AWS Bedrock",
    defaultModelID: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    fallbackModels: [
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      "us.amazon.nova-pro-v1:0",
    ],
    modelsEnv: "ARGUS_BEDROCK_MODELS",
    defaultModelEnv: "BEDROCK_MODEL",
    requiresEnv: "AWS_REGION",
  },
]

const cacheLifetimeMs = 5 * 60 * 1000

export const isProviderId = isKnownProviderId

function defaultModelOf(definition: ProviderDefinition) {
  return process.env[definition.defaultModelEnv ?? ""]?.trim() || undefined
}

function fallbackModels(definition: ProviderDefinition) {
  const override = process.env[definition.modelsEnv]?.split(",").map((model) => model.trim()).filter(Boolean)
  const base = [...override?.length ? override : definition.fallbackModels]
  const preferred = defaultModelOf(definition)
  if (preferred && !base.includes(preferred)) base.unshift(preferred)
  return [...new Set(base)]
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

/** Walks a chain of object keys, returning undefined the moment the path is not an object. */
function recordAt(source: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | undefined {
  let current: Record<string, unknown> | undefined = source
  for (const key of keys) {
    if (!current) return undefined
    const next = current[key]
    if (!next || typeof next !== "object" || Array.isArray(next)) return undefined
    current = next as Record<string, unknown>
  }
  return current
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

/**
 * Bedrock exposes two catalogs: the foundation models available in the region, and the
 * cross-region inference profiles (`us.` / `global.` prefixed) that actually spread a request
 * across regions. Both are invocable model IDs, so both belong in the picker.
 */
async function discoverBedrock(key: string): Promise<DiscoveredModels> {
  const region = requireValue(process.env.AWS_REGION, "AWS_REGION")
  const endpoint = `https://bedrock.${region}.amazonaws.com`
  const auth = { Authorization: `Bearer ${key}` }
  const foundation = await fetchJson(`${endpoint}/foundation-models?byOutputModality=TEXT`, auth, "AWS Bedrock")
  // Reading the profile catalog needs a second permission, so a key that can list models but not
  // profiles still yields a usable picker instead of falling back to nothing.
  const profiles = await fetchJson(`${endpoint}/inference-profiles`, auth, "AWS Bedrock").catch(() => undefined)

  const summaries = foundation && typeof foundation === "object" && !Array.isArray(foundation)
    ? (foundation as Record<string, unknown>).modelSummaries
    : undefined
  if (!Array.isArray(summaries)) throw new Error("AWS Bedrock model discovery returned an invalid model list")

  const metadata: ModelMetadata[] = []
  for (const item of summaries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const model = item as Record<string, unknown>
    // Argus always streams through the Converse API, so a model that cannot stream Converse
    // is unusable here even though Bedrock lists it.
    const converse = recordAt(model, "inferenceAPIsSupported", "converse")
    if (converse?.streaming !== true) continue
    const id = typeof model.modelId === "string" ? model.modelId.trim() : ""
    if (!id) continue
    const name = optionalName(model.modelName)
    const provider = optionalName(model.providerName)
    const maxOutputTokens = positiveNumber(recordAt(model, "converse")?.maxTokensMaximum)
    metadata.push({
      id,
      ...(name ? { name: provider ? `${name} · ${provider}` : name } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    })
  }

  const profileList = profiles && typeof profiles === "object" && !Array.isArray(profiles)
    ? (profiles as Record<string, unknown>).inferenceProfileSummaries
    : undefined
  if (Array.isArray(profileList)) {
    // A profile carries no output ceiling of its own, but it names the foundation model it routes
    // to, so the cap can be inherited and the orchestrator can still bound a turn.
    const byModelId = new Map(metadata.map((model) => [model.id, model]))
    for (const item of profileList) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue
      const profile = item as Record<string, unknown>
      const id = typeof profile.inferenceProfileId === "string" ? profile.inferenceProfileId.trim() : ""
      if (!id) continue
      if (typeof profile.status === "string" && profile.status !== "ACTIVE") continue
      const name = optionalName(profile.inferenceProfileName)
      const maxOutputTokens = profileTargets(profile)
        .map((modelId) => byModelId.get(modelId)?.maxOutputTokens)
        .find((value): value is number => value !== undefined)
      metadata.push({
        id,
        ...(name ? { name } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
      })
    }
  }

  const models = uniqueSorted(metadata.map((model) => model.id))
  if (!models.length) throw new Error("AWS Bedrock model discovery returned no Converse-capable models")
  return { models, modelMetadata: metadataRecord(models, metadata) }
}

/** Pulls the foundation-model IDs out of an inference profile's `modelArn` entries. */
function profileTargets(profile: Record<string, unknown>) {
  if (!Array.isArray(profile.models)) return []
  return profile.models.flatMap((entry): string[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return []
    const arn = (entry as Record<string, unknown>).modelArn
    if (typeof arn !== "string") return []
    const modelId = arn.split("/").pop()?.trim()
    return modelId ? [modelId] : []
  })
}

const discoverableProviders = new Set<ProviderId>(["openrouter", "google", "bedrock"])
type DiscoverableProviderId = "openrouter" | "google" | "bedrock"

async function discoverWithKey(id: DiscoverableProviderId, key: string) {
  if (id === "openrouter") return discoverOpenRouter(key)
  if (id === "google") return discoverGoogle(key)
  return discoverBedrock(key)
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
  if (discoverableProviders.has(id)) await discoverWithKey(id as DiscoverableProviderId, key)
}

async function discover(definition: ProviderDefinition, force: boolean): Promise<DiscoveryResult> {
  const fallback = fallbackModels(definition)
  const fallbackMetadata = metadataRecord(fallback)
  if (!discoverableProviders.has(definition.id)) {
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
    const pending = withProviderCredential(definition.id, (key) => discoverWithKey(definition.id as DiscoverableProviderId, key))
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
  const defaultModelID = defaultModelOf(definition)
    ?? (discovered.models.includes(definition.defaultModelID)
      ? definition.defaultModelID
      : discovered.models[0] ?? definition.defaultModelID)
  const configured = hasProviderCredential(definition.id)
    && (!definition.requiresEnv || Boolean(process.env[definition.requiresEnv]?.trim()))
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
    case "bedrock":
      return requireProviderCredential("bedrock", "AWS_BEARER_TOKEN_BEDROCK", (apiKey) => createAmazonBedrock({
        apiKey,
        region: requireValue(process.env.AWS_REGION, "AWS_REGION"),
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
