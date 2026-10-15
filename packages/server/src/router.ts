import { readFile } from "node:fs/promises"
import type { ProviderId } from "@argus/shared"

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone"
const JEV_MODEL = "jev-latest"
/** Jev Choice questions accept at most 255 options; keep headroom. */
const MAX_CANDIDATES = 250
const MAX_PROBLEM_CHARS = 32_000
/** Descriptions are capped so a full catalog stays cheap to evaluate. */
const MAX_DESCRIPTION_CHARS = 220
const ROUTER_PROVIDER: ProviderId = "openrouter"

export class RouterError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
  }
}

interface Candidate {
  id: string
  description: string | null
}

export interface RoleRecommendation {
  providerID: ProviderId
  modelID: string
  description: string | null
  probability: number
  confidence: number
  alternatives: Array<{ providerID: ProviderId; modelID: string; probability: number }>
}

export interface RecommendationResult {
  model: string
  usage: { inputTokens: number; outputTokens: number }
  candidatesConsidered: number
  truncated: boolean
  roles: {
    framer: RoleRecommendation
    answerer: RoleRecommendation
    observer: RoleRecommendation
  }
}

let catalogCache: Candidate[] | undefined

/** First sentence, hard-capped: enough for "what kind of model is this" without the marketing. */
function summarize(description: string) {
  const clean = description.replace(/\s+/g, " ").trim()
  if (!clean) return null
  const first = clean.split(/(?<=[.!?])\s/)[0] ?? clean
  const text = first.length <= MAX_DESCRIPTION_CHARS ? first : `${first.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…`
  return text || null
}

/**
 * Loads the master model list (an OpenRouter catalog snapshot) once per process and
 * keeps only what Jev should see: the model ID and a short description. Pricing,
 * context windows, architecture, and every other field stay out of the request.
 */
async function catalog(): Promise<Candidate[]> {
  if (catalogCache) return catalogCache
  let body: unknown
  try {
    body = JSON.parse(await readFile(new URL("../../../master_models_list.json", import.meta.url), "utf8"))
  } catch {
    throw new RouterError("master_models_list.json could not be read", 500, "ROUTER_CATALOG_MISSING")
  }
  const data = body && typeof body === "object" ? (body as Record<string, unknown>).data : undefined
  if (!Array.isArray(data)) throw new RouterError("master_models_list.json has an unexpected shape", 500, "ROUTER_CATALOG_MISSING")

  const seen = new Set<string>()
  const list: Candidate[] = []
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const id = typeof record.id === "string" ? record.id.trim() : ""
    if (!id || seen.has(id)) continue
    const architecture = record.architecture
    if (architecture && typeof architecture === "object" && !Array.isArray(architecture)) {
      const output = (architecture as Record<string, unknown>).output_modalities
      if (Array.isArray(output) && !output.includes("text")) continue
    }
    seen.add(id)
    list.push({
      id,
      description: typeof record.description === "string" ? summarize(record.description) : null,
    })
  }
  if (!list.length) throw new RouterError("master_models_list.json lists no usable models", 500, "ROUTER_CATALOG_MISSING")
  catalogCache = list
  return list
}

const ROLE_QUESTIONS = {
  framer: "Which model should play the Task Framer for this problem? The framer turns a vague problem into scope, deliverables, and verifiable acceptance criteria. It needs strong instruction following, structured writing, and planning.",
  answerer: "Which model should play the Answer Agent for this problem? The answerer does the actual work over multiple rounds with tools. It needs the strongest reasoning and domain knowledge this problem demands.",
  observer: "Which model should play the Observer for this problem? The observer independently re-verifies every acceptance criterion with its own evidence and rules them met or not met. It needs careful, skeptical reasoning, and a model from a different family than the answerer is preferable for diversity of judgment.",
} as const

interface JevChoiceAnswer {
  type: "choice"
  choice?: unknown
  probabilities?: unknown
  confidence?: unknown
}

function recommendation(answer: JevChoiceAnswer | undefined, list: Candidate[], role: string): RoleRecommendation {
  const known = new Set(list.map((candidate) => candidate.id))
  const probabilities = answer?.probabilities && typeof answer.probabilities === "object" && !Array.isArray(answer.probabilities)
    ? answer.probabilities as Record<string, unknown>
    : {}
  const ranked = Object.entries(probabilities)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && known.has(entry[0]))
    .sort((a, b) => b[1] - a[1])
  const chosen = typeof answer?.choice === "string" && known.has(answer.choice) ? answer.choice : ranked[0]?.[0]
  if (!chosen) throw new RouterError(`Jev returned no usable ${role} recommendation`, 502, "ROUTER_BAD_RESPONSE")
  const probability = ranked.find(([id]) => id === chosen)?.[1] ?? 0
  const alternatives = ranked
    .filter(([id]) => id !== chosen)
    .slice(0, 4)
    .map(([id, probability]) => ({ providerID: ROUTER_PROVIDER, modelID: id, probability }))
  return {
    providerID: ROUTER_PROVIDER,
    modelID: chosen,
    description: list.find((candidate) => candidate.id === chosen)?.description ?? null,
    probability,
    confidence: typeof answer?.confidence === "number" ? answer.confidence : probability,
    alternatives,
  }
}

export async function recommendModels(problem: string): Promise<RecommendationResult> {
  const key = process.env.TYPESAFE_API_KEY?.trim()
  if (!key) throw new RouterError("TYPESAFE_API_KEY is not configured on the Argus server", 503, "ROUTER_NOT_CONFIGURED")
  const trimmed = problem.trim()
  if (!trimmed) throw new RouterError("problem must be a non-empty string", 400, "VALIDATION_ERROR")
  if (trimmed.length > MAX_PROBLEM_CHARS) throw new RouterError(`problem must be at most ${MAX_PROBLEM_CHARS} characters`, 400, "VALIDATION_ERROR")

  const full = await catalog()
  const list = full.slice(0, MAX_CANDIDATES)
  const criteria = Object.fromEntries(list.map((candidate) => [candidate.id, candidate.description]))
  const questions = Object.fromEntries(Object.entries(ROLE_QUESTIONS).map(([role, instructions]) => [role, {
    type: "choice",
    instructions,
    criteria,
  }]))

  let response: Response
  try {
    response = await fetch(TYPESAFE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state: trimmed, model: JEV_MODEL, questions }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new RouterError("The Jev recommendation request failed", 502, "ROUTER_REQUEST_FAILED")
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new RouterError(
      `Jev recommendation failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      response.status === 401 || response.status === 403 ? 503 : 502,
      response.status === 401 || response.status === 403 ? "ROUTER_NOT_CONFIGURED" : "ROUTER_REQUEST_FAILED",
    )
  }

  const body: unknown = await response.json().catch(() => undefined)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RouterError("Jev returned an invalid response", 502, "ROUTER_BAD_RESPONSE")
  }
  const record = body as Record<string, unknown>
  const answers = record.answers && typeof record.answers === "object" && !Array.isArray(record.answers)
    ? record.answers as Record<string, JevChoiceAnswer>
    : {}
  const usage = record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
    ? record.usage as Record<string, unknown>
    : {}

  return {
    model: typeof record.model === "string" ? record.model : JEV_MODEL,
    usage: {
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    },
    candidatesConsidered: list.length,
    truncated: full.length > list.length,
    roles: {
      framer: recommendation(answers.framer, list, "framer"),
      answerer: recommendation(answers.answerer, list, "answerer"),
      observer: recommendation(answers.observer, list, "observer"),
    },
  }
}
