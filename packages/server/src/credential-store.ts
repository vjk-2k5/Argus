import type { ProviderId } from "@argus/shared"
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

export type CredentialSource = "stored" | "environment" | null

type StoredCredentials = Partial<Record<ProviderId, string>>

const providerIds = ["openai", "anthropic", "google", "openrouter", "openai-compatible"] as const satisfies readonly ProviderId[]
const providerIdSet = new Set<string>(providerIds)
const environmentVariables: Record<ProviderId, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "openai-compatible": "ARGUS_OPENAI_COMPATIBLE_API_KEY",
}

function credentialPath() {
  const override = process.env.ARGUS_AUTH_PATH?.trim()
  if (override) return isAbsolute(override) ? override : resolve(override)
  return join(process.env.USERPROFILE?.trim() || homedir(), ".argus", "auth.json")
}

export function isKnownProviderId(value: string): value is ProviderId {
  return providerIdSet.has(value)
}

function validateStoredCredentials(value: unknown): StoredCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const result: StoredCredentials = {}
  for (const [id, key] of Object.entries(value)) {
    if (!isKnownProviderId(id) || typeof key !== "string" || !key.trim()) return {}
    result[id] = key.trim()
  }
  return result
}

function loadStoredCredentials() {
  try {
    return validateStoredCredentials(JSON.parse(readFileSync(credentialPath(), "utf8")))
  } catch {
    return {}
  }
}

let storedCredentials = loadStoredCredentials()
let credentialWrite = Promise.resolve()
export function credentialSource(id: ProviderId): CredentialSource {
  if (storedCredentials[id]) return "stored"
  return process.env[environmentVariables[id]]?.trim() ? "environment" : null
}

export function hasProviderCredential(id: ProviderId) {
  return credentialSource(id) !== null
}

export function withProviderCredential<T>(id: ProviderId, use: (key: string) => T): T | undefined {
  const stored = storedCredentials[id]
  if (stored) return use(stored)
  const environment = process.env[environmentVariables[id]]?.trim()
  return environment ? use(environment) : undefined
}

async function persistCredentials(credentials: StoredCredentials) {
  const path = credentialPath()
  const directory = dirname(path)
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    await chmod(directory, 0o700)
  } catch {
    // Windows and some filesystems do not fully support POSIX modes.
  }
  try {
    await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    try {
      await chmod(temporary, 0o600)
    } catch {
      // Best effort on platforms without POSIX permissions.
    }
    await rename(temporary, path)
    try {
      await chmod(path, 0o600)
    } catch {
      // Best effort on platforms without POSIX permissions.
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function mutateCredentials(mutation: (credentials: StoredCredentials) => void) {
  const operation = credentialWrite.then(async () => {
    const next = { ...storedCredentials }
    mutation(next)
    await persistCredentials(next)
    storedCredentials = next
  })
  credentialWrite = operation.catch(() => undefined)
  return operation
}

export async function setStoredCredential(id: ProviderId, key: string) {
  const normalized = key.trim()
  if (!normalized) throw new Error("Credential must not be blank")
  await mutateCredentials((credentials) => {
    credentials[id] = normalized
  })
}

export async function deleteStoredCredential(id: ProviderId) {
  await mutateCredentials((credentials) => {
    delete credentials[id]
  })
}
