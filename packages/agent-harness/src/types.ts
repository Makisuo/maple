import type { ModelMessage, StreamTextOnFinishCallback, StreamTextResult, ToolSet } from "ai"
import { Schema } from "effect"
import type { Effect } from "effect"
import type { AgentHarnessError } from "./errors"

export const AgentToolResultSchema = Schema.Struct({
	content: Schema.Array(
		Schema.Struct({
			type: Schema.Literal("text"),
			text: Schema.String,
		}),
	),
	isError: Schema.optionalKey(Schema.Boolean),
})

export type AgentToolResult = Schema.Schema.Type<typeof AgentToolResultSchema>

export interface AgentToolDefinition {
	readonly name: string
	readonly description: string
	readonly schema: Schema.Decoder<unknown, never>
	readonly execute: (params: unknown) => Effect.Effect<AgentToolResult, unknown, any>
}

export interface AgentToolRegistrar {
	tool<TSchema extends Schema.Decoder<unknown, never>>(
		name: string,
		description: string,
		schema: TSchema,
		handler: (params: TSchema["Type"]) => Effect.Effect<AgentToolResult, unknown, any>,
	): void
}

export interface AgentToolRegistryShape {
	readonly definitions: ReadonlyArray<AgentToolDefinition>
}

export const SessionUsageSchema = Schema.Struct({
	inputTokens: Schema.optionalKey(Schema.Number),
	outputTokens: Schema.optionalKey(Schema.Number),
	totalTokens: Schema.optionalKey(Schema.Number),
	recordedAtEntryId: Schema.String,
	recordedAt: Schema.Number,
})

export type SessionUsage = Schema.Schema.Type<typeof SessionUsageSchema>

export const CompactionSettingsSchema = Schema.Struct({
	enabled: Schema.Boolean,
	reserveTokens: Schema.Number,
	keepRecentTokens: Schema.Number,
})

export type CompactionSettings = Schema.Schema.Type<typeof CompactionSettingsSchema>

export const CompactionDetailsSchema = Schema.Struct({
	readFiles: Schema.optionalKey(Schema.Array(Schema.String)),
	modifiedFiles: Schema.optionalKey(Schema.Array(Schema.String)),
	toolNames: Schema.optionalKey(Schema.Array(Schema.String)),
	droppedEntryIds: Schema.optionalKey(Schema.Array(Schema.String)),
	turnContextEntryIds: Schema.optionalKey(Schema.Array(Schema.String)),
})

export type CompactionDetails = Schema.Schema.Type<typeof CompactionDetailsSchema>

const MessageEntrySchema = Schema.Struct({
	id: Schema.String,
	createdAt: Schema.Number,
	turnId: Schema.String,
	type: Schema.Literal("message"),
	message: Schema.Unknown,
	estimatedTokens: Schema.Number,
})

const ModelChangeEntrySchema = Schema.Struct({
	id: Schema.String,
	createdAt: Schema.Number,
	turnId: Schema.String,
	type: Schema.Literal("model_change"),
	model: Schema.String,
})

const ThinkingLevelChangeEntrySchema = Schema.Struct({
	id: Schema.String,
	createdAt: Schema.Number,
	turnId: Schema.String,
	type: Schema.Literal("thinking_level_change"),
	thinkingLevel: Schema.String,
})

const CompactionEntrySchema = Schema.Struct({
	id: Schema.String,
	createdAt: Schema.Number,
	turnId: Schema.String,
	type: Schema.Literal("compaction"),
	summary: Schema.String,
	firstKeptEntryId: Schema.String,
	tokensBefore: Schema.Number,
	turnContextSummary: Schema.optionalKey(Schema.String),
	details: CompactionDetailsSchema,
})

const CustomMessageEntrySchema = Schema.Struct({
	id: Schema.String,
	createdAt: Schema.Number,
	turnId: Schema.String,
	type: Schema.Literal("custom_message"),
	role: Schema.Literals(["user", "assistant", "system"]),
	text: Schema.String,
	estimatedTokens: Schema.Number,
})

const SessionStartEntrySchema = Schema.Struct({
	id: Schema.String,
	createdAt: Schema.Number,
	turnId: Schema.String,
	type: Schema.Literal("session"),
	sessionId: Schema.String,
})

export const SessionEntrySchema = Schema.Union([
	SessionStartEntrySchema,
	MessageEntrySchema,
	ModelChangeEntrySchema,
	ThinkingLevelChangeEntrySchema,
	CompactionEntrySchema,
	CustomMessageEntrySchema,
])

export type SessionStartEntry = Schema.Schema.Type<typeof SessionStartEntrySchema>
export type SessionMessageEntry = Omit<Schema.Schema.Type<typeof MessageEntrySchema>, "message"> & {
	readonly message: ModelMessage
}
export type SessionModelChangeEntry = Schema.Schema.Type<typeof ModelChangeEntrySchema>
export type SessionThinkingLevelChangeEntry = Schema.Schema.Type<typeof ThinkingLevelChangeEntrySchema>
export type SessionCompactionEntry = Schema.Schema.Type<typeof CompactionEntrySchema>
export type SessionCustomMessageEntry = Schema.Schema.Type<typeof CustomMessageEntrySchema>
export type SessionEntry =
	| SessionStartEntry
	| SessionMessageEntry
	| SessionModelChangeEntry
	| SessionThinkingLevelChangeEntry
	| SessionCompactionEntry
	| SessionCustomMessageEntry

export const HarnessCommandSchema = Schema.Struct({
	id: Schema.String,
	kind: Schema.Literals(["continue", "steer", "follow_up"]),
	text: Schema.String,
	createdAt: Schema.Number,
})

export type HarnessCommand = Schema.Schema.Type<typeof HarnessCommandSchema>

export const SessionSnapshotSchema = Schema.Struct({
	sessionId: Schema.String,
	nextTurnIndex: Schema.Number,
	entries: Schema.Array(SessionEntrySchema),
	pendingCommands: Schema.Array(HarnessCommandSchema),
	compaction: CompactionSettingsSchema,
	lastSuccessfulUsage: Schema.optionalKey(SessionUsageSchema),
	activeModel: Schema.optionalKey(Schema.String),
	activeThinkingLevel: Schema.optionalKey(Schema.String),
})

export type SessionSnapshot = Omit<
	Schema.Schema.Type<typeof SessionSnapshotSchema>,
	"entries" | "pendingCommands"
> & {
	readonly entries: ReadonlyArray<SessionEntry>
	readonly pendingCommands: ReadonlyArray<HarnessCommand>
}

export interface CompactionPreparation {
	readonly tokensBefore: number
	readonly firstKeptEntryId: string
	readonly keptEntries: ReadonlyArray<SessionEntry>
	readonly droppedEntries: ReadonlyArray<SessionEntry>
	readonly historyEntries: ReadonlyArray<SessionEntry>
	readonly turnContextEntries: ReadonlyArray<SessionEntry>
	readonly previousCompaction: SessionCompactionEntry | undefined
	readonly details: CompactionDetails
}

export interface CompactionSummary {
	readonly summary: string
	readonly turnContextSummary?: string
	readonly details?: Partial<CompactionDetails>
}

export interface CompactionResult {
	readonly snapshot: SessionSnapshot
	readonly entry: SessionCompactionEntry
	readonly preparation: CompactionPreparation
}

export interface AgentEvent {
	readonly type:
		| "agent_start"
		| "agent_end"
		| "turn_start"
		| "turn_end"
		| "tool_execution_start"
		| "tool_execution_end"
		| "compaction_start"
		| "compaction_end"
	readonly sessionId: string
	readonly turnId: string
	readonly createdAt: number
	readonly details?: Record<string, unknown>
}

export interface AgentSessionStoreShape {
	readonly load: (sessionId: string) => Effect.Effect<SessionSnapshot, AgentHarnessError>
	readonly appendEntries: (
		snapshot: SessionSnapshot,
		entries: ReadonlyArray<SessionEntry>,
		options?: {
			readonly nextTurnIndex?: number
			readonly lastSuccessfulUsage?: SessionUsage
			readonly activeModel?: string
			readonly activeThinkingLevel?: string
			readonly pendingCommands?: ReadonlyArray<HarnessCommand>
		},
	) => Effect.Effect<SessionSnapshot, AgentHarnessError>
	readonly update: (
		sessionId: string,
		f: (snapshot: SessionSnapshot) => SessionSnapshot,
	) => Effect.Effect<SessionSnapshot, AgentHarnessError>
}

export interface AgentModelGatewayShape {
	readonly modelId: string
	readonly contextWindow: number
	readonly summarizeCompaction: (input: {
		readonly snapshot: SessionSnapshot
		readonly preparation: CompactionPreparation
		readonly abortSignal?: AbortSignal
	}) => Effect.Effect<CompactionSummary, AgentHarnessError>
	readonly streamTurn: <TOOLS extends ToolSet>(input: {
		readonly system: string
		readonly messages: ReadonlyArray<ModelMessage>
		readonly tools: TOOLS
		readonly abortSignal?: AbortSignal
		readonly onFinish?: StreamTextOnFinishCallback<TOOLS>
	}) => StreamTextResult<TOOLS, any>
}

export interface AgentPromptInput {
	readonly text: string
	readonly turnId: string
	readonly system: string
	readonly abortSignal?: AbortSignal
}
