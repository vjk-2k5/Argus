import { Hono } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import { CreateSessionSchema, FrameApprovalSchema, FrameUpdateSchema, ToolAccessSchema } from "@argus/shared"
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  recoverInterruptedSessions,
  sessionDetail,
  updateSession,
} from "./db"
import { publish, subscribe } from "./events"
import { cancelSession, frameSession, pauseDebate, resumeDebate, startDebate, stopSessionForDeletion } from "./orchestrator"
import { deleteStoredCredential, setStoredCredential } from "./credential-store"
import {
  invalidateProviderCache,
  isProviderId,
  providerDefaults,
  providerViews,
  verifyProviderCredential,
} from "./providers"
import { recommendModels, RouterError } from "./router"
import { filesystemRoots, listFilesystemDirectory, resolveWorkspaceDirectory, sessionsRoot, workspaceFor } from "./tools/fs"
import { shellName } from "./tools/shell"
import { toolDescriptors } from "./tools/registry"
import type { ProviderId } from "@argus/shared"

const app = new Hono()
app.use("/api/*", cors({ origin: ["http://localhost:5173", "http://127.0.0.1:5173"] }))

function error(c: any, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}

function view(id: string) {
  const detail = sessionDetail(id)
  if (!detail) return undefined
  return {
    ...detail,
    frame: detail.frame ? { ...detail.frame, approved: detail.frameApproved } : undefined,
    usage: {
      inputTokens: detail.inputTokens,
      outputTokens: detail.outputTokens,
      totalTokens: detail.inputTokens + detail.outputTokens,
      cost: detail.costUsd,
      currency: "USD",
    },
    finalReport: detail.finalReport ? { text: detail.finalReport } : undefined,
    unverifiedModelClaims: detail.toolAccess !== "off",
  }
}

async function providerResponse(refresh?: boolean | ProviderId) {
  const providers = refresh === undefined ? await providerViews() : await providerViews({ refresh })
  return { providers, defaults: providerDefaults(providers) }
}

app.get("/api/health", (c) => c.json({ ok: true }))
app.get("/api/providers", async (c) => {
  try {
    return c.json(await providerResponse())
  } catch {
    return error(c, 502, "PROVIDER_DISCOVERY_ERROR", "Unable to load provider models")
  }
})

app.put("/api/providers/:id/key", async (c) => {
  const id = c.req.param("id")
  if (!isProviderId(id)) return error(c, 400, "INVALID_PROVIDER", "Unknown provider")
  const body: unknown = await c.req.json().catch(() => undefined)
  const key = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).key
    : undefined
  if (typeof key !== "string" || !key.trim() || key.length > 16_384) {
    return error(c, 400, "VALIDATION_ERROR", "key must be a non-empty string")
  }
  const normalizedKey = key.trim()
  try {
    await verifyProviderCredential(id, normalizedKey)
  } catch {
    return error(c, 400, "CREDENTIAL_VERIFICATION_FAILED", "Provider credential verification failed")
  }
  try {
    await setStoredCredential(id, normalizedKey)
  } catch {
    return error(c, 500, "CREDENTIAL_STORE_ERROR", "Unable to store provider credential")
  }
  invalidateProviderCache(id)
  try {
    return c.json(await providerResponse(id))
  } catch {
    return error(c, 502, "PROVIDER_DISCOVERY_ERROR", "Credential stored, but provider models could not be refreshed")
  }
})

app.delete("/api/providers/:id/key", async (c) => {
  const id = c.req.param("id")
  if (!isProviderId(id)) return error(c, 400, "INVALID_PROVIDER", "Unknown provider")
  try {
    await deleteStoredCredential(id)
  } catch {
    return error(c, 500, "CREDENTIAL_STORE_ERROR", "Unable to remove provider credential")
  }
  invalidateProviderCache(id)
  try {
    return c.json(await providerResponse(id))
  } catch {
    return error(c, 502, "PROVIDER_DISCOVERY_ERROR", "Credential removed, but provider models could not be refreshed")
  }
})

app.post("/api/providers/:id/refresh", async (c) => {
  const id = c.req.param("id")
  if (!isProviderId(id)) return error(c, 400, "INVALID_PROVIDER", "Unknown provider")
  try {
    return c.json(await providerResponse(id))
  } catch {
    return error(c, 502, "PROVIDER_DISCOVERY_ERROR", "Unable to refresh provider models")
  }
})

app.get("/api/sessions", (c) => c.json({ sessions: listSessions() }))

app.get("/api/tools", (c) => c.json({ tools: toolDescriptors(), sessionsRoot: sessionsRoot(), shell: shellName() }))

app.post("/api/router/recommend", async (c) => {
  const body: unknown = await c.req.json().catch(() => undefined)
  const problem = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).problem
    : undefined
  if (typeof problem !== "string") return error(c, 400, "VALIDATION_ERROR", "problem must be a string")
  try {
    return c.json(await recommendModels(problem))
  } catch (cause) {
    if (cause instanceof RouterError) return error(c, cause.status, cause.code, cause.message)
    return error(c, 502, "ROUTER_REQUEST_FAILED", cause instanceof Error ? cause.message : "Recommendation failed")
  }
})

app.get("/api/fs/directories", async (c) => {
  try {
    const listing = await listFilesystemDirectory(c.req.query("path"))
    return c.json({ ...listing, roots: await filesystemRoots() })
  } catch (cause) {
    return error(c, 400, "INVALID_PATH", cause instanceof Error ? cause.message : String(cause))
  }
})

app.post("/api/sessions", async (c) => {
  const parsed = CreateSessionSchema.safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) return error(c, 400, "VALIDATION_ERROR", parsed.error.message)
  const id = crypto.randomUUID()
  const title = parsed.data.title ?? parsed.data.problem.slice(0, 100)
  let workspace = ""
  if (parsed.data.workspace || parsed.data.toolAccess !== "off") {
    try {
      workspace = await resolveWorkspaceDirectory(parsed.data.workspace)
        ?? workspaceFor(title, parsed.data.problem, id)
    } catch (cause) {
      return error(c, 400, "INVALID_WORKSPACE", cause instanceof Error ? cause.message : String(cause))
    }
  }
  createSession({
    id,
    title,
    problem: parsed.data.problem,
    maxRounds: parsed.data.maxRounds,
    roles: parsed.data.roles,
    toolAccess: parsed.data.toolAccess,
    workspace,
  })
  queueMicrotask(() => void frameSession(id))
  return c.json(view(id), 201)
})

app.put("/api/sessions/:id/tools", async (c) => {
  const id = c.req.param("id")
  const session = getSession(id)
  if (!session) return error(c, 404, "NOT_FOUND", "Session not found")
  if (["completed", "cancelled", "failed"].includes(session.status)) {
    return error(c, 409, "INVALID_STATE", `Tool access cannot be changed on a ${session.status} session`)
  }
  const body: unknown = await c.req.json().catch(() => undefined)
  const access = ToolAccessSchema.safeParse(
    body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).toolAccess : undefined,
  )
  if (!access.success) return error(c, 400, "VALIDATION_ERROR", "toolAccess must be off, read, or full")
  const workspace = access.data === "off" ? session.workspace : (session.workspace || workspaceFor(session.title, session.problem, id))
  updateSession(id, { toolAccess: access.data, workspace })
  publish(id, { type: "session.tools", toolAccess: access.data, workspace })
  return c.json(view(id))
})

app.get("/api/sessions/:id", (c) => {
  const result = view(c.req.param("id"))
  return result ? c.json(result) : error(c, 404, "NOT_FOUND", "Session not found")
})

app.delete("/api/sessions/:id", async (c) => {
  const id = c.req.param("id")
  if (!getSession(id)) return error(c, 404, "NOT_FOUND", "Session not found")
  await stopSessionForDeletion(id)
  return deleteSession(id)
    ? c.body(null, 204)
    : error(c, 404, "NOT_FOUND", "Session not found")
})

app.put("/api/sessions/:id/frame", async (c) => {
  const id = c.req.param("id")
  const session = getSession(id)
  if (!session) return error(c, 404, "NOT_FOUND", "Session not found")
  if (!['awaiting_approval', 'ready'].includes(session.status)) {
    return error(c, 409, "INVALID_STATE", "The frame cannot be edited after the debate starts")
  }
  const parsed = FrameUpdateSchema.safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) return error(c, 400, "VALIDATION_ERROR", parsed.error.message)
  updateSession(id, {
    frame: parsed.data,
    maxRounds: parsed.data.maxRounds,
    frameApproved: false,
    status: "awaiting_approval",
  })
  publish(id, { type: "frame.updated", frame: parsed.data, approved: false })
  return c.json(view(id))
})

app.post("/api/sessions/:id/frame/approve", async (c) => {
  const id = c.req.param("id")
  const session = getSession(id)
  if (!session) return error(c, 404, "NOT_FOUND", "Session not found")
  if (!["awaiting_approval", "ready"].includes(session.status)) {
    return error(c, 409, "INVALID_STATE", "The frame can only be approved before the debate starts")
  }
  const parsed = FrameApprovalSchema.safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) return error(c, 400, "VALIDATION_ERROR", parsed.error.message)
  if (!session.frame) return error(c, 409, "INVALID_STATE", "Task framing is not complete")
  updateSession(id, { frameApproved: true, status: "ready" })
  publish(id, { type: "frame.updated", frame: session.frame, approved: true })
  publish(id, { type: "session.status", status: "ready" })
  return c.json(view(id))
})

app.post("/api/sessions/:id/start", (c) => {
  try {
    startDebate(c.req.param("id"))
    return c.json(view(c.req.param("id")))
  } catch (cause) {
    return error(c, 409, "INVALID_STATE", cause instanceof Error ? cause.message : String(cause))
  }
})

app.post("/api/sessions/:id/pause", (c) => {
  try {
    pauseDebate(c.req.param("id"))
    return c.json(view(c.req.param("id")))
  } catch (cause) {
    return error(c, 409, "INVALID_STATE", cause instanceof Error ? cause.message : String(cause))
  }
})

app.post("/api/sessions/:id/resume", async (c) => {
  try {
    await resumeDebate(c.req.param("id"))
    return c.json(view(c.req.param("id")))
  } catch (cause) {
    return error(c, 409, "INVALID_STATE", cause instanceof Error ? cause.message : String(cause))
  }
})

app.post("/api/sessions/:id/cancel", (c) => {
  try {
    cancelSession(c.req.param("id"))
    return c.json(view(c.req.param("id")))
  } catch (cause) {
    return error(c, 409, "INVALID_STATE", cause instanceof Error ? cause.message : String(cause))
  }
})

app.get("/api/sessions/:id/events", (c) => {
  const id = c.req.param("id")
  const session = getSession(id)
  if (!session) return error(c, 404, "NOT_FOUND", "Session not found")
  return streamSSE(c, async (stream) => {
    let open = true
    let chain = Promise.resolve()
    const unsubscribe = subscribe(id, (event) => {
      chain = chain.then(() => stream.writeSSE({ id: event.id, data: JSON.stringify(event) })).then(() => undefined)
    })
    stream.onAbort(() => {
      open = false
      unsubscribe()
    })
    await stream.writeSSE({ data: JSON.stringify({
      id: crypto.randomUUID(),
      sessionId: id,
      at: new Date().toISOString(),
      event: { type: "session.status", status: session.status },
    }) })
    while (open) {
      await stream.sleep(10_000)
      if (open) await stream.writeSSE({ event: "ping", data: String(Date.now()) })
    }
  })
})

app.notFound((c) => error(c, 404, "NOT_FOUND", "Route not found"))
app.onError((cause, c) => {
  console.error(cause)
  return error(c, 500, "INTERNAL_ERROR", cause.message)
})

const port = Number(process.env.ARGUS_PORT ?? 3001)
const hostname = process.env.ARGUS_HOST?.trim() || "127.0.0.1"
recoverInterruptedSessions()
// SSE event streams stay silent while a model thinks or a tool runs, which regularly exceeds
// Bun's 10s default. Disable the idle timeout so long debates are not disconnected mid-round.
Bun.serve({ port, hostname, fetch: app.fetch, idleTimeout: 0 })
console.log(`Argus server listening on http://${hostname}:${port}`)
