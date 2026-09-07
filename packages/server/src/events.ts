import type { SessionEventData, SseEventEnvelope } from "@argus/shared"

type Listener = (event: SseEventEnvelope) => void
const listeners = new Map<string, Set<Listener>>()

export function publish(sessionId: string, event: SessionEventData) {
  const envelope: SseEventEnvelope = {
    id: crypto.randomUUID(),
    sessionId,
    at: new Date().toISOString(),
    event,
  }
  for (const listener of listeners.get(sessionId) ?? []) listener(envelope)
  return envelope
}

export function subscribe(sessionId: string, listener: Listener) {
  const group = listeners.get(sessionId) ?? new Set<Listener>()
  group.add(listener)
  listeners.set(sessionId, group)
  return () => {
    group.delete(listener)
    if (group.size === 0) listeners.delete(sessionId)
  }
}
