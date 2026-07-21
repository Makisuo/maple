import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { ChatApplyRequest } from "@maple/domain/http"
import { makeChatApplyPayload } from "./chat-apply-payload"

describe("makeChatApplyPayload", () => {
	it("constructs an encodable ChatApplyRequest", () => {
		const payload = makeChatApplyPayload("update_dashboard_widget", { title: "Latency" })

		expect(payload).toBeInstanceOf(ChatApplyRequest)
		expect(() => Schema.encodeUnknownSync(ChatApplyRequest)(payload)).not.toThrow()
	})
})
