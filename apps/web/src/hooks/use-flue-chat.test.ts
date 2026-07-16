import { describe, expect, it } from "vitest"
import { isFlueChatLoading, isResponseSettled } from "./use-flue-chat"

describe("Flue response lifecycle", () => {
	it("keeps the composer blocked through a mid-stream reconnect until idle", () => {
		let pendingResponse = true
		const lifecycle = ["submitted", "streaming", "connecting", "streaming"] as const

		for (const status of lifecycle) {
			expect(isResponseSettled(status)).toBe(false)
			expect(isFlueChatLoading(status, pendingResponse)).toBe(true)
		}

		const finalStatus = "idle" as const
		expect(isResponseSettled(finalStatus)).toBe(true)
		pendingResponse = false
		expect(isFlueChatLoading(finalStatus, pendingResponse)).toBe(false)
	})

	it("settles a failed response", () => {
		expect(isResponseSettled("error")).toBe(true)
		expect(isFlueChatLoading("error", false)).toBe(false)
	})
})
