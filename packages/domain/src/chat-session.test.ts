import { describe, expect, it } from "vitest"
import {
	chatModeFromSessionId,
	decodeChatEvent,
	encodeChatEvent,
	investigationIdFromChatSessionId,
	makeChatSessionId,
	orgIdFromChatSessionId,
	tabIdFromChatSessionId,
	ChatTextDeltaEvent,
	ChatToolCallEvent,
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
})
