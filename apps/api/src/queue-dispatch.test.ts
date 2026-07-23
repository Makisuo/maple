import { describe, expect, it } from "vitest"
import { classifyWorkerQueue } from "./queue-dispatch"

const env = {
	PLANETSCALE_WEBHOOK_QUEUE_NAME: "maple-planetscale-webhooks-local",
	VCS_SYNC_QUEUE_NAME: "maple-vcs-sync-local",
}

describe("classifyWorkerQueue", () => {
	it("dispatches each configured queue by its exact name", () => {
		expect(classifyWorkerQueue("maple-planetscale-webhooks-local", env)).toBe("planetscale-webhook")
		expect(classifyWorkerQueue("maple-vcs-sync-local", env)).toBe("vcs-sync")
	})

	it("does not route an unknown queue through the VCS consumer", () => {
		expect(classifyWorkerQueue("maple-unknown-local", env)).toBe("unknown")
	})
})
