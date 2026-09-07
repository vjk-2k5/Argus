import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { EventEnvelope, MessageView, SessionDetailView, SseEventView } from "./types";

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
      setLastEvent({ envelope, receivedAt: Date.now() });
      const event = envelope.event;
      queryClient.setQueryData<SessionDetailView>(key, (current) => {
        if (!current) return current;
        if (event.type === "session.status") return { ...current, status: event.status };
        if (event.type === "frame.updated") {
          return { ...current, frame: { ...event.frame, approved: event.approved }, frameApproved: event.approved };
        }
        if (event.type === "round.started") return { ...current, currentRound: event.round };
        if (event.type === "message.started") {
          if (current.messages.some((item) => item.id === event.messageId)) return current;
          return { ...current, messages: [...current.messages, placeholder(envelope)!] };
        }
        if (event.type === "part.delta") {
          return {
            ...current,
            messages: current.messages.map((item) => item.id !== event.messageId ? item : {
              ...item,
              [event.kind]: item[event.kind] + event.delta,
            }),
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
      if (["session.status", "frame.updated", "final.report", "error"].includes(event.type)) {
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
