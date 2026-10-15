import type {
  CreateSessionInput as SharedCreateSessionInput,
  Frame,
  JsonValue,
  ProviderId,
  RoleConfigs,
  RoleModelConfig,
  SessionStatus,
  SseEventEnvelope,
  ToolAccess as SharedToolAccess,
  ToolDescriptor as SharedToolDescriptor,
  Part as SharedPart,
  ToolInvocation as SharedToolInvocation,
  ToolInvocationState,
  ToolName,
} from "@argus/shared";

export type AgentRole = "framer" | "answerer" | "observer";
export type DebateRole = Exclude<AgentRole, "framer">;
export type RoleModel = RoleModelConfig;
export type CreateSessionInput = Omit<SharedCreateSessionInput, "toolAccess"> & { toolAccess: ToolAccess };
export type EventEnvelope = SseEventEnvelope;
export type ToolAccess = SharedToolAccess;
export type ToolInvocation = SharedToolInvocation;
export type ToolInvocationView = SharedToolInvocation & { state: ToolInvocationState };
export type ToolDescriptorView = SharedToolDescriptor;
export type { ToolName };

export interface ToolCatalogView {
  tools: ToolDescriptorView[];
  sessionsRoot: string;
  shell: string;
}

export interface DirectoryListingView {
  path: string;
  parent: string | null;
  directories: Array<{ name: string; path: string }>;
  roots: string[];
  error?: string;
}

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
/** One piece of a turn in the order the model produced it: reasoning, a tool call, or prose. */
export type PartView = SharedPart;

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
  toolAccess: ToolAccess;
  createdAt: number;
  updatedAt: number;
  error?: string | null;
}

export interface SessionDetailView extends SessionSummaryView {
  roles: RoleConfigs;
  frame?: FrameView;
  frameApproved: boolean;
  toolAccess: ToolAccess;
  workspace: string;
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

export interface RoleRecommendationView {
  providerID: ProviderId;
  modelID: string;
  description: string | null;
  probability: number;
  confidence: number;
  alternatives: Array<{ providerID: ProviderId; modelID: string; probability: number }>;
}

export interface RecommendationView {
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  candidatesConsidered: number;
  truncated: boolean;
  roles: Record<AgentRole, RoleRecommendationView>;
}

export interface SseEventView {
  envelope: EventEnvelope;
  receivedAt: number;
}
