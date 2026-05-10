import { createEntityRegistry } from "@electric-ax/agents-runtime"
import { MAPLE_CHAT_ENTITY_TYPE } from "@maple/ai"
import { describe, expect, it } from "vitest"
import { registerMapleChatEntity } from "./maple-chat"

const env = {
	ELECTRIC_AGENTS_URL: "http://localhost:4437",
	MAPLE_AGENTS_PORT: 3480,
	MAPLE_AGENTS_SERVE_URL: "http://localhost:3480",
}

describe("maple_chat entity", () => {
	it("registers creation schemas, inbox schemas, and approval state", () => {
		const registry = createEntityRegistry()

		registerMapleChatEntity(registry, env)

		const entry = registry.get(MAPLE_CHAT_ENTITY_TYPE)
		expect(entry?.name).toBe(MAPLE_CHAT_ENTITY_TYPE)
		expect(entry?.definition.creationSchema).toBeDefined()
		expect(entry?.definition.inboxSchemas).toHaveProperty("user_message")
		expect(entry?.definition.inboxSchemas).toHaveProperty("approval_response")
		expect(entry?.definition.state).toHaveProperty("approvalRequests")
		expect(entry?.definition.state?.approvalRequests?.primaryKey).toBe("id")
	})
})
