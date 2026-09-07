import type { Frame } from "@argus/shared";
import type {
  CreateSessionInput,
  ProviderResponseView,
  SessionDetailView,
  SessionSummaryView,
} from "./types";

const API = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const data = await response.json().catch(() => undefined) as
    | { error?: { code?: string; message?: string } }
    | T
    | undefined;
  if (!response.ok) {
    const detail = data && typeof data === "object" && "error" in data ? data.error : undefined;
    throw new Error(detail?.message ?? `Request failed (${response.status})`);
  }
  return data as T;
}

export function getProviders() {
  return request<ProviderResponseView>("/providers");
}

export async function getSessions() {
  const result = await request<{ sessions: SessionSummaryView[] }>("/sessions");
  return result.sessions;
}

export function getSession(id: string) {
  return request<SessionDetailView>(`/sessions/${encodeURIComponent(id)}`);
}

export function deleteSession(id: string) {
  return request<void>(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function createSession(input: CreateSessionInput) {
  return request<SessionDetailView>("/sessions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateFrame(id: string, frame: Frame) {
  return request<SessionDetailView>(`/sessions/${encodeURIComponent(id)}/frame`, {
    method: "PUT",
    body: JSON.stringify(frame),
  });
}

export function approveFrame(id: string) {
  return request<SessionDetailView>(`/sessions/${encodeURIComponent(id)}/frame/approve`, {
    method: "POST",
    body: JSON.stringify({ approved: true }),
  });
}

function action(id: string, name: "start" | "pause" | "resume" | "cancel") {
  return request<SessionDetailView>(`/sessions/${encodeURIComponent(id)}/${name}`, {
    method: "POST",
  });
}

export const startSession = (id: string) => action(id, "start");
export const pauseSession = (id: string) => action(id, "pause");
export const resumeSession = (id: string) => action(id, "resume");
export const cancelSession = (id: string) => action(id, "cancel");

export function connectProvider(providerID: string, key: string) {
  return request<ProviderResponseView>(`/providers/${encodeURIComponent(providerID)}/key`, {
    method: "PUT",
    body: JSON.stringify({ key }),
  });
}

export function disconnectProvider(providerID: string) {
  return request<ProviderResponseView>(`/providers/${encodeURIComponent(providerID)}/key`, {
    method: "DELETE",
  });
}

export function refreshProvider(providerID: string) {
  return request<ProviderResponseView>(`/providers/${encodeURIComponent(providerID)}/refresh`, {
    method: "POST",
  });
}
