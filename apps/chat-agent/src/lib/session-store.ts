import { Effect } from "effect"
import {
	AgentHarnessStoreError,
	createEmptySnapshot,
	type AgentSessionStoreShape,
	type HarnessCommand,
	type SessionEntry,
	type SessionSnapshot,
	type SessionUsage,
} from "@maple/agent-harness"

type SqlValue = string | number | boolean | null

export interface DurableSqlClient {
	<T = Record<string, SqlValue>>(strings: TemplateStringsArray, ...values: SqlValue[]): T[]
}

const ensureTables = (sql: DurableSqlClient) => {
	sql`
    CREATE TABLE IF NOT EXISTS agent_harness_sessions (
      session_id TEXT PRIMARY KEY,
      metadata_json TEXT NOT NULL
    )
  `

	sql`
    CREATE TABLE IF NOT EXISTS agent_harness_entries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      entry_id TEXT NOT NULL UNIQUE,
      turn_id TEXT NOT NULL,
      entry_json TEXT NOT NULL
    )
  `

	sql`
    CREATE INDEX IF NOT EXISTS agent_harness_entries_session_seq
    ON agent_harness_entries (session_id, seq)
  `
}

const serializeMetadata = (snapshot: SessionSnapshot): string =>
	JSON.stringify({
		sessionId: snapshot.sessionId,
		nextTurnIndex: snapshot.nextTurnIndex,
		pendingCommands: snapshot.pendingCommands,
		compaction: snapshot.compaction,
		lastSuccessfulUsage: snapshot.lastSuccessfulUsage,
		activeModel: snapshot.activeModel,
		activeThinkingLevel: snapshot.activeThinkingLevel,
	})

const restoreSnapshot = (
	sessionId: string,
	metadataJson: string | undefined,
	entryJsons: ReadonlyArray<string>,
): SessionSnapshot => {
	if (!metadataJson) {
		return createEmptySnapshot(sessionId)
	}

	const parsed = JSON.parse(metadataJson) as Omit<SessionSnapshot, "entries">
	const entries = entryJsons.map((entry) => JSON.parse(entry) as SessionEntry)
	return {
		...parsed,
		sessionId,
		entries,
	}
}

const persistSnapshot = (
	sql: DurableSqlClient,
	snapshot: SessionSnapshot,
	newEntries: ReadonlyArray<SessionEntry>,
) => {
	for (const entry of newEntries) {
		sql`
      INSERT OR IGNORE INTO agent_harness_entries (session_id, entry_id, turn_id, entry_json)
      VALUES (${snapshot.sessionId}, ${entry.id}, ${entry.turnId}, ${JSON.stringify(entry)})
    `
	}

	sql`
    INSERT INTO agent_harness_sessions (session_id, metadata_json)
    VALUES (${snapshot.sessionId}, ${serializeMetadata(snapshot)})
    ON CONFLICT(session_id) DO UPDATE SET metadata_json = excluded.metadata_json
  `
}

export const createDurableObjectSessionStore = (sql: DurableSqlClient): AgentSessionStoreShape => ({
	load: (sessionId: string) =>
		Effect.try({
			try: () => {
				ensureTables(sql)
				const metadataRow = sql<{ metadata_json: string }>`
          SELECT metadata_json
          FROM agent_harness_sessions
          WHERE session_id = ${sessionId}
          LIMIT 1
        `[0]
				const entryRows = sql<{ entry_json: string }>`
          SELECT entry_json
          FROM agent_harness_entries
          WHERE session_id = ${sessionId}
          ORDER BY seq ASC
        `

				const snapshot = restoreSnapshot(
					sessionId,
					metadataRow?.metadata_json,
					entryRows.map((row) => row.entry_json),
				)

				if (!metadataRow) {
					persistSnapshot(sql, snapshot, snapshot.entries)
				}

				return snapshot
			},
			catch: (error) =>
				new AgentHarnessStoreError({
					message: error instanceof Error ? error.message : String(error),
				}),
		}),
	appendEntries: (
		snapshot: SessionSnapshot,
		entries: ReadonlyArray<SessionEntry>,
		options?: {
			readonly nextTurnIndex?: number
			readonly lastSuccessfulUsage?: SessionUsage
			readonly activeModel?: string
			readonly activeThinkingLevel?: string
			readonly pendingCommands?: ReadonlyArray<HarnessCommand>
		},
	) =>
		Effect.try({
			try: () => {
				ensureTables(sql)
				const nextSnapshot: SessionSnapshot = {
					...snapshot,
					nextTurnIndex: options?.nextTurnIndex ?? snapshot.nextTurnIndex,
					lastSuccessfulUsage: options?.lastSuccessfulUsage ?? snapshot.lastSuccessfulUsage,
					activeModel: options?.activeModel ?? snapshot.activeModel,
					activeThinkingLevel: options?.activeThinkingLevel ?? snapshot.activeThinkingLevel,
					pendingCommands: options?.pendingCommands ?? snapshot.pendingCommands,
					entries: [...snapshot.entries, ...entries],
				}
				persistSnapshot(sql, nextSnapshot, entries)
				return nextSnapshot
			},
			catch: (error) =>
				new AgentHarnessStoreError({
					message: error instanceof Error ? error.message : String(error),
				}),
		}),
	update: (sessionId: string, f: (snapshot: SessionSnapshot) => SessionSnapshot) =>
		Effect.gen(function* () {
			const current = yield* createDurableObjectSessionStore(sql).load(sessionId)
			const next = f(current)
			const newEntries = next.entries.slice(current.entries.length)
			return yield* createDurableObjectSessionStore(sql).appendEntries(current, newEntries, {
				nextTurnIndex: next.nextTurnIndex,
				lastSuccessfulUsage: next.lastSuccessfulUsage,
				activeModel: next.activeModel,
				activeThinkingLevel: next.activeThinkingLevel,
				pendingCommands: next.pendingCommands,
			})
		}),
})
