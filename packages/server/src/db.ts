import { Database as SQLite } from "bun:sqlite"
import { and, asc, desc, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { Frame, RoleConfigs, SessionStatus } from "@argus/shared"

export const sessions = sqliteTable("session", {
  id: text().primaryKey(),
  title: text().notNull(),
  problem: text().notNull(),
  status: text().$type<SessionStatus>().notNull(),
  maxRounds: integer("max_rounds").notNull(),
  currentRound: integer("current_round").notNull().default(0),
  roles: text({ mode: "json" }).$type<RoleConfigs>().notNull(),
  frame: text({ mode: "json" }).$type<Frame>(),
  frameApproved: integer("frame_approved", { mode: "boolean" }).notNull().default(false),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  finalReport: text("final_report"),
  error: text(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
})

export const messages = sqliteTable("message", {
  id: text().primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  role: text().$type<"user" | "framer" | "answerer" | "observer" | "system">().notNull(),
  round: integer().notNull().default(0),
  status: text().$type<"streaming" | "completed" | "aborted" | "failed">().notNull(),
  text: text().notNull().default(""),
  reasoning: text().notNull().default(""),
  metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  completedAt: integer("completed_at"),
}, (table) => [index("message_session_round_idx").on(table.sessionId, table.round)])

export const compactions = sqliteTable("compaction", {
  id: text().primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  throughMessageId: text("through_message_id").notNull(),
  round: integer().notNull(),
  summary: text().notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  createdAt: integer("created_at").notNull(),
}, (table) => [index("compaction_session_idx").on(table.sessionId, table.createdAt)])

const sqlite = new SQLite(process.env.ARGUS_DATABASE_PATH ?? "./argus.db", { create: true })
sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
sqlite.exec(`
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, problem TEXT NOT NULL, status TEXT NOT NULL,
  max_rounds INTEGER NOT NULL, current_round INTEGER NOT NULL DEFAULT 0, roles TEXT NOT NULL,
  frame TEXT, frame_approved INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, final_report TEXT,
  error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  role TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
  reasoning TEXT NOT NULL DEFAULT '', metadata TEXT, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS message_session_round_idx ON message(session_id, round);
CREATE TABLE IF NOT EXISTS compaction (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  through_message_id TEXT NOT NULL, round INTEGER NOT NULL, summary TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS compaction_session_idx ON compaction(session_id, created_at);
`)

export const db = drizzle({ client: sqlite })
export type SessionRow = typeof sessions.$inferSelect
export type MessageRow = typeof messages.$inferSelect
export type CompactionRow = typeof compactions.$inferSelect

export function createSession(input: {
  id: string
  title: string
  problem: string
  maxRounds: number
  roles: RoleConfigs
}) {
  const now = Date.now()
  db.insert(sessions).values({
    ...input,
    status: "framing",
    currentRound: 0,
    frameApproved: false,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    createdAt: now,
    updatedAt: now,
  }).run()
  return getSession(input.id)!
}

export function getSession(id: string) {
  return db.select().from(sessions).where(eq(sessions.id, id)).get()
}

export function listSessions() {
  return db.select().from(sessions).orderBy(desc(sessions.updatedAt)).all()
}

export function deleteSession(id: string) {
  return db.delete(sessions).where(eq(sessions.id, id)).run().changes > 0
}

export function recoverInterruptedSessions() {
  const now = Date.now()
  for (const session of listSessions()) {
    if (session.status !== "running" && session.status !== "framing") continue
    db.update(messages).set({ status: "aborted", completedAt: now }).where(and(
      eq(messages.sessionId, session.id),
      eq(messages.status, "streaming"),
    )).run()
    if (session.status === "running") {
      updateSession(session.id, { status: "paused" })
    } else {
      updateSession(session.id, {
        status: "failed",
        error: "Task framing was interrupted by a server restart. Start a new session to retry framing.",
      })
    }
  }
}

export function updateSession(id: string, patch: Partial<typeof sessions.$inferInsert>) {
  db.update(sessions).set({ ...patch, updatedAt: Date.now() }).where(eq(sessions.id, id)).run()
  return getSession(id)
}

export function createMessage(input: Pick<MessageRow, "id" | "sessionId" | "role" | "round"> & { text?: string; metadata?: Record<string, unknown> }) {
  const now = Date.now()
  db.insert(messages).values({
    ...input,
    status: "streaming",
    text: input.text ?? "",
    reasoning: "",
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    createdAt: now,
  }).run()
  return getMessage(input.id)!
}

export function getMessage(id: string) {
  return db.select().from(messages).where(eq(messages.id, id)).get()
}

export function updateMessage(id: string, patch: Partial<typeof messages.$inferInsert>) {
  db.update(messages).set(patch).where(eq(messages.id, id)).run()
  return getMessage(id)
}

export function completeMessage(id: string, input: {
  status: "completed" | "aborted" | "failed"
  text: string
  reasoning: string
  metadata?: Record<string, unknown>
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}) {
  const row = updateMessage(id, {
    ...input,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    costUsd: input.costUsd ?? 0,
    completedAt: Date.now(),
  })!
  if (input.status === "completed") addUsage(row.sessionId, row.inputTokens, row.outputTokens, row.costUsd)
  return row
}

export function listMessages(sessionId: string) {
  return db.select().from(messages).where(eq(messages.sessionId, sessionId)).orderBy(asc(messages.createdAt), asc(messages.id)).all()
}

export function completedMessage(sessionId: string, round: number, role: "answerer" | "observer") {
  return db.select().from(messages).where(and(
    eq(messages.sessionId, sessionId),
    eq(messages.round, round),
    eq(messages.role, role),
    eq(messages.status, "completed"),
  )).orderBy(desc(messages.createdAt)).get()
}

export function addUsage(sessionId: string, input: number, output: number, cost: number) {
  const row = getSession(sessionId)
  if (!row) return
  updateSession(sessionId, {
    inputTokens: row.inputTokens + input,
    outputTokens: row.outputTokens + output,
    costUsd: row.costUsd + cost,
  })
}

export function createCompaction(input: typeof compactions.$inferInsert) {
  db.insert(compactions).values(input).run()
  addUsage(input.sessionId, input.inputTokens ?? 0, input.outputTokens ?? 0, 0)
  return db.select().from(compactions).where(eq(compactions.id, input.id)).get()!
}

export function listCompactions(sessionId: string) {
  return db.select().from(compactions).where(eq(compactions.sessionId, sessionId)).orderBy(asc(compactions.createdAt)).all()
}

export function latestCompaction(sessionId: string) {
  return db.select().from(compactions).where(eq(compactions.sessionId, sessionId)).orderBy(desc(compactions.createdAt)).get()
}

export function sessionDetail(id: string) {
  const session = getSession(id)
  if (!session) return undefined
  return { ...session, messages: listMessages(id), compactions: listCompactions(id) }
}
