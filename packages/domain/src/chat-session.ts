/**
 * Wire contract for Maple's own durable chat transport, which replaces Flue's.
 *
 * Three shapes live here so the Worker, the web client and the mobile client cannot drift:
 *
 *   - `ChatSessionId` — `"<orgId>:<tabId>"`. The org is recovered *server-side* from the id and
 *     matched against the caller's token; it is never read from a request body.
 *   - `ChatEvent` — the durable, replayable event log. Every event carries a monotonic `seq`, so a
 *     reconnect is `GET .../events?cursor=<last seq>` and the transport is resumable by
 *     construction rather than by reconnect heuristics.
 *   - `ChatMessage` — the materialized transcript a cold client reads before it starts streaming.
 *
 * The event names are deliberately Maple's, not `@maple/llm`'s: `LLMEvent` is a provider-neutral
 * *model* stream, while this is a *session* stream that also carries user turns, approval gates and
 * turn lifecycle. `apps/api/src/chat/events.ts` is the only place the two are mapped.
 */
import { Schema } from "effect"

// ---------------------------------------------------------------------------
// Session addressing
// ---------------------------------------------------------------------------

/**
 * `"<orgId>:<tabId>"`. Mirrors the addressing Flue used (and the chat-agent Durable Object naming
 * before it), so existing deep links into a conversation keep working.
 */
export const ChatSessionId = Schema.String.pipe(Schema.brand("@maple/ChatSessionId"))
export type ChatSessionId = typeof ChatSessionId.Type

const decodeChatSessionId = Schema.decodeUnknownSync(ChatSessionId)

export const makeChatSessionId = (orgId: string, tabId: string): ChatSessionId =>
	decodeChatSessionId(`${orgId}:${tabId}`)

/**
 * Recover the org from a session id. Deny-by-default: a colon-less or leading-colon id carries no
 * resolvable org, so callers must reject it rather than treat the whole string as the org.
 */
export const orgIdFromChatSessionId = (sessionId: string): string | undefined => {
	const index = sessionId.indexOf(":")
	return index <= 0 ? undefined : sessionId.slice(0, index)
}

/** Everything after the first `:`. The tab-id prefix encodes the conversation mode. */
export const tabIdFromChatSessionId = (sessionId: string): string => {
	const index = sessionId.indexOf(":")
	return index === -1 ? "" : sessionId.slice(index + 1)
}

/** Recover the investigation id from an `inv-<id>` tab. `undefined` for other modes. */
export const investigationIdFromChatSessionId = (sessionId: string): string | undefined => {
	const tab = tabIdFromChatSessionId(sessionId)
	return tab.startsWith("inv-") ? tab.slice("inv-".length) : undefined
}

export const ChatMode = Schema.Literals([
	"default",
	"dashboard-builder",
	"alert",
	"widget-fix",
	"investigate",
])
export type ChatMode = Schema.Schema.Type<typeof ChatMode>

/** Mode is derived from the tab-id prefix, never sent by the client. */
export const chatModeFromSessionId = (sessionId: string): ChatMode => {
	const tab = tabIdFromChatSessionId(sessionId)
	if (tab.startsWith("dashboard-builder-")) return "dashboard-builder"
	if (tab.startsWith("alert-")) return "alert"
	if (tab.startsWith("widget-fix-")) return "widget-fix"
	if (tab.startsWith("inv-")) return "investigate"
	return "default"
}

// ---------------------------------------------------------------------------
// Durable transcript
// ---------------------------------------------------------------------------

export const ChatRole = Schema.Literals(["user", "assistant"])
export type ChatRole = Schema.Schema.Type<typeof ChatRole>

export class ChatToolCall extends Schema.Class<ChatToolCall>("@maple/ChatToolCall")({
	id: Schema.String,
	name: Schema.String,
	input: Schema.Unknown,
	/** Present once the tool settled. */
	output: Schema.optionalKey(Schema.Unknown),
	isError: Schema.optionalKey(Schema.Boolean),
	/**
	 * True when this call is an approval-gated mutation the agent paused on. The tool did NOT run;
	 * the client renders an approval card and applies it through `POST /api/chat/apply`.
	 */
	proposed: Schema.optionalKey(Schema.Boolean),
}) {}

export class ChatMessage extends Schema.Class<ChatMessage>("@maple/ChatMessage")({
	id: Schema.String,
	role: ChatRole,
	text: Schema.String,
	toolCalls: Schema.Array(ChatToolCall),
	createdAt: Schema.Number,
}) {}

export class ChatHistoryResponse extends Schema.Class<ChatHistoryResponse>("@maple/ChatHistoryResponse")({
	messages: Schema.Array(ChatMessage),
	/** Cursor to resume the event stream from; `0` means "from the beginning". */
	cursor: Schema.Number,
	/** True when a turn is in flight, so a reconnecting client shows the streaming state. */
	running: Schema.Boolean,
}) {}

// ---------------------------------------------------------------------------
// Event stream
// ---------------------------------------------------------------------------

const withSeq = <Fields extends Schema.Struct.Fields>(fields: Fields) => ({
	/** Monotonic per session, starting at 1. The reconnect cursor. */
	seq: Schema.Number,
	...fields,
})

export class ChatUserMessageEvent extends Schema.Class<ChatUserMessageEvent>("chat.user-message")(
	withSeq({ type: Schema.Literal("user-message"), id: Schema.String, text: Schema.String }),
) {}

export class ChatTurnStartEvent extends Schema.Class<ChatTurnStartEvent>("chat.turn-start")(
	withSeq({ type: Schema.Literal("turn-start"), messageId: Schema.String }),
) {}

export class ChatTextDeltaEvent extends Schema.Class<ChatTextDeltaEvent>("chat.text-delta")(
	withSeq({ type: Schema.Literal("text-delta"), messageId: Schema.String, text: Schema.String }),
) {}

export class ChatToolCallEvent extends Schema.Class<ChatToolCallEvent>("chat.tool-call")(
	withSeq({
		type: Schema.Literal("tool-call"),
		messageId: Schema.String,
		callId: Schema.String,
		name: Schema.String,
		input: Schema.Unknown,
		/** Approval-gated mutation: the tool did not run, this is a proposal. */
		proposed: Schema.optionalKey(Schema.Boolean),
	}),
) {}

export class ChatToolResultEvent extends Schema.Class<ChatToolResultEvent>("chat.tool-result")(
	withSeq({
		type: Schema.Literal("tool-result"),
		messageId: Schema.String,
		callId: Schema.String,
		output: Schema.Unknown,
		isError: Schema.optionalKey(Schema.Boolean),
	}),
) {}

export class ChatTurnEndEvent extends Schema.Class<ChatTurnEndEvent>("chat.turn-end")(
	withSeq({
		type: Schema.Literal("turn-end"),
		messageId: Schema.String,
		reason: Schema.Literals(["stop", "aborted", "error", "max-steps"]),
		/** Present when `reason` is `"error"`. */
		error: Schema.optionalKey(Schema.String),
	}),
) {}

export const ChatEvent = Schema.Union([
	ChatUserMessageEvent,
	ChatTurnStartEvent,
	ChatTextDeltaEvent,
	ChatToolCallEvent,
	ChatToolResultEvent,
	ChatTurnEndEvent,
]).pipe(Schema.toTaggedUnion("type"))
export type ChatEvent = Schema.Schema.Type<typeof ChatEvent>

/** Distributive `Omit`, so each union member keeps its own discriminated shape. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/**
 * A `ChatEvent` before the session assigns it a `seq`. Producers (the agent turn, the submission
 * path) emit this shape; the Durable Object owns ordering and stamps the `seq`.
 */
export type ChatEventInput = DistributiveOmit<ChatEvent, "seq">

/** One SSE frame is exactly one encoded `ChatEvent`; the SSE `id:` field is its `seq`. */
export const encodeChatEvent = Schema.encodeUnknownSync(Schema.fromJsonString(ChatEvent))
export const decodeChatEvent = Schema.decodeUnknownSync(Schema.fromJsonString(ChatEvent))

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export class ChatSendRequest extends Schema.Class<ChatSendRequest>("@maple/ChatSendRequest")({
	/** The full message text, with any client-side context preamble already folded in. */
	text: Schema.String,
}) {}

export class ChatSendResponse extends Schema.Class<ChatSendResponse>("@maple/ChatSendResponse")({
	/** Cursor immediately BEFORE this submission's first event, so no event is missed. */
	cursor: Schema.Number,
	messageId: Schema.String,
}) {}
