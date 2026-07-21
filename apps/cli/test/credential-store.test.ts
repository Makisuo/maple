import { describe, expect, it } from "vitest"
import { credentialAccount } from "../src/core/credential-store"

describe("credentialAccount", () => {
	it("keys credentials by normalized API origin", () => {
		expect(credentialAccount("https://api.maple.dev/v2/")).toBe("https://api.maple.dev")
		expect(credentialAccount("http://localhost:3472/api/auth")).toBe("http://localhost:3472")
	})
})
