import type {
  CreateSessionInput as SharedCreateSessionInput,
  Frame,
  JsonValue,
  ProviderId,
  RoleConfigs,
  RoleModelConfig,
  SessionStatus,
  SseEventEnvelope,
} from "@argus/shared";

export type AgentRole = "framer" | "answerer" | "observer";
export type DebateRole = Exclude<AgentRole, "framer">;
export type RoleModel = RoleModelConfig;
export type CreateSessionInput = SharedCreateSessionInput;
export type EventEnvelope = SseEventEnvelope;

export interface ModelMetadataView {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ProviderView {
  id: ProviderId;
  name: string;
  models: string[];
  modelMetadata: Record<string, ModelMetadataView>;
  defaultModelID: string;
  configured: boolean;
  credentialSource: "stored" | "environment" | null;
  modelSource: "api" | "fallback";
  modelError?: string;
}

export type FrameView = Frame & { approved: boolean };

export interface MessageView {
  id: string;
  sessionId: string;
  role: "user" | AgentRole | "system";
  round: number;
  status: "streaming" | "completed" | "aborted" | "failed";
  text: string;
  reasoning: string;
  metadata?: JsonValue | Record<string, unknown>;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  createdAt: number;
  completedAt: number | null;
}
export interface CompactionView {
  id: string;
  sessionId: string;
  throughMessageId: string;
  round: number;
  summary: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: number;
}

export interface SessionSummaryView {
  id: string;
  title: string;
  problem: string;
  status: SessionStatus;
  currentRound: number;
  maxRounds: number;
  createdAt: number;
  updatedAt: number;
  error?: string | null;
}

export interface SessionDetailView extends SessionSummaryView {
  roles: RoleConfigs;
  frame?: FrameView;
  frameApproved: boolean;
  messages: MessageView[];
  compactions: CompactionView[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number | null;
    currency: string;
  };
  finalReport?: {
    text: string;
    terminationKind?: "criteria_met" | "max_rounds";
    terminationReason?: string;
  };
  unverifiedModelClaims: boolean;
}

export interface ProviderResponseView {
  providers: ProviderView[];
  defaults: RoleConfigs;
}

export interface SseEventView {
  envelope: EventEnvelope;
  receivedAt: number;
}
