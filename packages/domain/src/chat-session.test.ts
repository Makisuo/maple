import { describe, expect, it } from "vitest"
import {
	ChatTurnTenant,
	chatModeFromSessionId,
	decodeChatTurnTenant,
	encodeChatTurnTenant,
	decodeChatEvent,
	decodeChatEventOrThrow,
	decodeChatEventPayload,
	encodeChatEvent,
	encodeChatEventPayload,
	investigationIdFromChatSessionId,
	makeChatSessionId,
	orgIdFromChatSessionId,
	tabIdFromChatSessionId,
	ChatTextDeltaEvent,
	ChatToolCallEvent,
	type ChatEventInput,
} from "./chat-session"

describe("chat session ids", () => {
	it("round-trips org and tab", () => {
		const id = makeChatSessionId("org_abc", "tab-1")
		expect(id).toBe("org_abc:tab-1")
		expect(orgIdFromChatSessionId(id)).toBe("org_abc")
		expect(tabIdFromChatSessionId(id)).toBe("tab-1")
	})

	it("keeps colons inside the tab id", () => {
		// The org is everything before the FIRST colon; a tab id is free to contain more.
		expect(orgIdFromChatSessionId("org_abc:widget-fix-d1:w2")).toBe("org_abc")
		expect(tabIdFromChatSessionId("org_abc:widget-fix-d1:w2")).toBe("widget-fix-d1:w2")
	})

	it("denies ids that carry no resolvable org", () => {
		// Deny-by-default: neither of these may be treated as "the whole string is the org".
		expect(orgIdFromChatSessionId("no-colon")).toBeUndefined()
		expect(orgIdFromChatSessionId(":leading")).toBeUndefined()
	})

	it("derives the mode from the tab prefix", () => {
		expect(chatModeFromSessionId("o:tab-1")).toBe("default")
		expect(chatModeFromSessionId("o:alert-inc_1")).toBe("alert")
		expect(chatModeFromSessionId("o:widget-fix-d1-w2")).toBe("widget-fix")
		expect(chatModeFromSessionId("o:inv-123")).toBe("investigate")
		expect(chatModeFromSessionId("o:dashboard-builder-1")).toBe("dashboard-builder")
	})

	it("recovers the investigation id only for investigate sessions", () => {
		expect(investigationIdFromChatSessionId("o:inv-abc")).toBe("abc")
		expect(investigationIdFromChatSessionId("o:alert-abc")).toBeUndefined()
	})
})

describe("chat events", () => {
	it("round-trips through the wire encoding", () => {
		const event = new ChatTextDeltaEvent({ seq: 7, type: "text-delta", messageId: "m1", text: "hi" })
		const decoded = decodeChatEvent(encodeChatEvent(event))
		expect(decoded).toMatchObject({ seq: 7, type: "text-delta", messageId: "m1", text: "hi" })
	})

	it("carries the approval flag on a proposed tool call", () => {
		// `proposed` is what tells the client to render an approval card instead of a running tool.
		const event = new ChatToolCallEvent({
			seq: 3,
			type: "tool-call",
			messageId: "m1",
			callId: "c1",
			name: "update_dashboard",
			input: { id: "d1" },
			proposed: true,
		})
		const decoded = decodeChatEvent(encodeChatEvent(event))
		expect(decoded).toMatchObject({ type: "tool-call", proposed: true, name: "update_dashboard" })
	})

	it("skips a frame it does not understand instead of throwing", () => {
		// A throwing decode escaped the client's read loop, which then reconnected from *before* the
		// bad frame — so the server replayed it and the client threw again, until the retry budget
		// ran out and the conversation was dead. Returning undefined means one new event type
		// degrades an old client rather than bricking it.
		expect(decodeChatEvent(JSON.stringify({ seq: 1, type: "from-a-newer-server" }))).toBeUndefined()
		expect(decodeChatEvent("not json at all")).toBeUndefined()
		// Structurally invalid members of a *known* type are skipped too.
		expect(decodeChatEvent(JSON.stringify({ seq: 1, type: "text-delta" }))).toBeUndefined()
	})

	it("still throws on demand, for producers that control both ends", () => {
		expect(() => decodeChatEventOrThrow(JSON.stringify({ type: "nope" }))).toThrow()
	})
})

describe("chat event storage codec", () => {
	// The durable log stores an event without its `seq` — the SQLite row key is the seq — so this is
	// a separate pair from the SSE codecs. It exists because the Durable Object used to read rows
	// back with `JSON.parse(payload) as ChatEvent`, which turns a shape change into a malformed
	// event handed straight to the transcript fold rather than an error at the boundary.
	it("round-trips every member, taking the seq from the row key", () => {
		const inputs: ReadonlyArray<ChatEventInput> = [
			{ type: "user-message", id: "u1", text: "hello" },
			{ type: "turn-start", messageId: "a1" },
			{ type: "text-delta", messageId: "a1", text: "hi" },
			{ type: "tool-call", messageId: "a1", callId: "c1", name: "t", input: { a: 1 } },
			{ type: "tool-call", messageId: "a1", callId: "c2", name: "t", input: {}, proposed: true },
			{ type: "tool-result", messageId: "a1", callId: "c1", output: "ok" },
			{ type: "tool-result", messageId: "a1", callId: "c1", output: "no", isError: true },
			{ type: "turn-end", messageId: "a1", reason: "stop" },
			{ type: "turn-end", messageId: "a1", reason: "error", error: "boom" },
		]

		for (const input of inputs) {
			const decoded = decodeChatEventPayload(encodeChatEventPayload(input), 42)
			expect(decoded).toEqual({ ...input, seq: 42 })
		}
	})

	it("rejects a stored payload that is not a known event", () => {
		expect(() => decodeChatEventPayload(JSON.stringify({ type: "nonsense" }), 1)).toThrow()
	})
})

describe("ChatTurnTenant", () => {
	it("crosses the Durable Object boundary as a structured-cloneable plain object", () => {
		// Load-bearing, not pedantry: Durable Object RPC serializes with structured clone, which
		// refuses class instances outright. As a `Schema.Class` this failed every `beginTurn` with
		// `DataCloneError: Could not serialize object of type "ChatTurnTenant"` — while `history()`
		// kept working, because it returns object literals. Only an end-to-end run caught it.
		const encoded = encodeChatTurnTenant({
			orgId: "org_1" as ChatTurnTenant["orgId"],
			userId: "user_1" as ChatTurnTenant["userId"],
			roles: [],
			authMode: "self_hosted",
		})

		expect(Object.getPrototypeOf(encoded)).toBe(Object.prototype)
		expect(() => structuredClone(encoded)).not.toThrow()
		expect(structuredClone(encoded)).toEqual(encoded)

		// And it round-trips back to branded values on the far side.
		const decoded = decodeChatTurnTenant(structuredClone(encoded))
		expect(decoded.orgId).toBe("org_1")
		expect(decoded.authMode).toBe("self_hosted")
	})
})
