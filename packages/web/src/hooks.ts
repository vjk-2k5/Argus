import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  EventEnvelope,
  MessageView,
  PartView,
  SessionDetailView,
  SseEventView,
  ToolInvocation,
} from "./types";

function placeholder(envelope: EventEnvelope): MessageView | undefined {
  const event = envelope.event;
  if (event.type !== "message.started") return;
  return {
    id: event.messageId,
    sessionId: envelope.sessionId,
    role: event.role,
    round: event.round,
    status: "streaming",
    text: "",
    reasoning: "",
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    createdAt: Date.now(),
    completedAt: null,
  };
}

function toolCallsOf(message: MessageView): ToolInvocation[] {
  const metadata = message.metadata as Record<string, unknown> | undefined;
  const calls = metadata?.toolCalls;
  return Array.isArray(calls) ? (calls as ToolInvocation[]) : [];
}

function partsOf(message: MessageView): PartView[] {
  const metadata = message.metadata as Record<string, unknown> | undefined;
  const parts = metadata?.parts;
  return Array.isArray(parts) ? (parts as PartView[]) : [];
}

function withParts(message: MessageView, parts: PartView[]): MessageView {
  return { ...message, metadata: { ...(message.metadata as object), parts } };
}

function withTool(message: MessageView, tool: ToolInvocation): MessageView {
  const calls = toolCallsOf(message);
  const index = calls.findIndex((item) => item.id === tool.id);
  const next = index < 0 ? [...calls, tool] : calls.map((item, at) => (at === index ? tool : item));
  return { ...message, metadata: { ...(message.metadata as object), toolCalls: next } };
}

function startPart(message: MessageView, partId: string, kind: PartView["kind"], toolId?: string): MessageView {
  const parts = partsOf(message);
  if (parts.some((part) => part.id === partId)) return message;
  return withParts(message, [...parts, { id: partId, kind, text: "", ...(toolId ? { toolId } : {}) }]);
}

function appendPartDelta(message: MessageView, partId: string, delta: string): MessageView {
  const parts = partsOf(message);
  const index = parts.findIndex((part) => part.id === partId);
  if (index < 0) return message;
  const partsNext = [...parts];
  partsNext[index] = { ...parts[index], text: parts[index].text + delta };
  return withParts(message, partsNext);
}

export function useSessionEvents(sessionID?: string) {
  const queryClient = useQueryClient();
  const [lastEvent, setLastEvent] = useState<SseEventView>();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!sessionID) return;
    const key = ["session", sessionID] as const;
    const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionID)}/events`);

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      let envelope: EventEnvelope;
      try {
        envelope = JSON.parse(message.data) as EventEnvelope;
      } catch {
        return;
      }
      const event = envelope?.event;
      if (!event || typeof event !== "object") return;
      setLastEvent({ envelope, receivedAt: Date.now() });
      queryClient.setQueryData<SessionDetailView>(key, (current) => {
        if (!current) return current;
        if (event.type === "session.status") return { ...current, status: event.status };
        if (event.type === "session.tools") {
          return { ...current, toolAccess: event.toolAccess, workspace: event.workspace };
        }
        if (event.type === "frame.updated") {
          return { ...current, frame: { ...event.frame, approved: event.approved }, frameApproved: event.approved };
        }
        if (event.type === "round.started") return { ...current, currentRound: event.round };
        if (event.type === "message.started") {
          if (current.messages.some((item) => item.id === event.messageId)) return current;
          return { ...current, messages: [...current.messages, placeholder(envelope)!] };
        }
        if (event.type === "part.started") {
          return {
            ...current,
            messages: current.messages.map((item) => item.id !== event.messageId ? item
              : startPart(item, event.partId, event.kind)),
          };
        }
        if (event.type === "part.delta") {
          return {
            ...current,
            messages: current.messages.map((item) => item.id !== event.messageId ? item : {
              ...appendPartDelta(item, event.partId, event.delta),
              [event.kind]: (event.kind === "text" ? item.text : item.reasoning) + event.delta,
            }),
          };
        }
        if (event.type === "turn.cut") {
          return {
            ...current,
            messages: current.messages.map((item) => item.id !== event.messageId ? item
              : { ...item, metadata: { ...(item.metadata as object), cut: event.reason } }),
          };
        }
        if (event.type === "tool.updated") {          return {
            ...current,
            messages: current.messages.map((item) =>
              item.id !== event.messageId ? item : withTool(item, event.tool)),
          };
        }
        if (event.type === "question.asked") {
          return {
            ...current,
            messages: current.messages.map((item) =>
              item.id !== event.messageId
                ? item
                : withTool(item, {
                  id: `${event.messageId}:question:${event.question}`,
                  name: "question",
                  state: "completed",
                  arguments: { question: event.question, options: event.options },
                  title: event.question,
                  output: `Asked the user: ${event.question}`,
                  startedAt: Date.now(),
                  endedAt: Date.now(),
                })),
          };
        }
        if (event.type === "usage.updated") {
          return { ...current, usage: {
            ...current.usage,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            totalTokens: event.inputTokens + event.outputTokens,
            cost: event.costUsd,
          } };
        }
        if (event.type === "compaction.created") {
          if (current.compactions.some((item) => item.id === event.id)) return current;
          return { ...current, compactions: [...current.compactions, {
            id: event.id,
            sessionId: envelope.sessionId,
            throughMessageId: "",
            round: current.currentRound,
            summary: event.summary,
            inputTokens: 0,
            outputTokens: 0,
            createdAt: Date.now(),
          }] };
        }
        if (event.type === "final.report") return { ...current, finalReport: { text: event.text } };
        if (event.type === "error") return { ...current, error: event.message };
        return current;
      });
      if (event.type === "message.completed" || event.type === "session.status") {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      if (["session.status", "frame.updated", "final.report", "error", "session.tools"].includes(event.type)) {
        void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      }
    };

    return () => {
      source.close();
      setConnected(false);
    };
  }, [queryClient, sessionID]);

  return { connected, lastEvent };
}
