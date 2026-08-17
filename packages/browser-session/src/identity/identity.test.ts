import { describe, expect, it } from "vitest"
import { normalizeIdentity } from "./identity"

describe("normalizeIdentity", () => {
	it("accepts the legacy bare user id", () => {
		// Every existing caller passes a string; this is what lets the richer
		// identity ship without touching them.
		expect(normalizeIdentity("user_123")).toEqual({
			id: "user_123",
			traits: {},
		})
	})

	it("clears on null, undefined, and empty input", () => {
		expect(normalizeIdentity(null)).toBeUndefined()
		expect(normalizeIdentity(undefined)).toBeUndefined()
		expect(normalizeIdentity("   ")).toBeUndefined()
		// An object with nothing usable reads the same as clearing.
		expect(normalizeIdentity({})).toBeUndefined()
		expect(normalizeIdentity({ id: "", email: undefined })).toBeUndefined()
	})

	it("keeps the full Better Stack-shaped identity", () => {
		expect(
			normalizeIdentity({
				id: "user_123",
				email: "user@example.com",
				username: "John Doe",
				groupId: "org_456",
				groupName: "Acme Inc.",
				traits: { plan: "premium" },
			}),
		).toEqual({
			id: "user_123",
			email: "user@example.com",
			username: "John Doe",
			groupId: "org_456",
			groupName: "Acme Inc.",
			traits: { plan: "premium" },
		})
	})

	it("coerces trait values and drops the unusable ones", () => {
		const resolved = normalizeIdentity({
			id: "u",
			traits: { seats: 12, trial: false, missing: null, absent: undefined },
		})
		// The column is Map(_, String), and a stored "undefined" is worse than an
		// absent key.
		expect(resolved?.traits).toEqual({ seats: "12", trial: "false" })
	})

	it("caps trait count, key length and value length", () => {
		const traits: Record<string, string> = {}
		for (let i = 0; i < 100; i++) traits[`k${i}`] = "v"
		traits["x".repeat(200)] = "y".repeat(1000)

		const resolved = normalizeIdentity({ id: "u", traits })
		// Trait keys share a ClickHouse LowCardinality dictionary, so an unbounded
		// key space degrades every query on the table.
		expect(Object.keys(resolved?.traits ?? {})).toHaveLength(24)
		for (const [key, value] of Object.entries(resolved?.traits ?? {})) {
			expect(key.length).toBeLessThanOrEqual(64)
			expect(value.length).toBeLessThanOrEqual(256)
		}
	})

	it("trims surrounding whitespace", () => {
		expect(normalizeIdentity({ id: "  user_123  ", groupId: " org_1 " })).toMatchObject({
			id: "user_123",
			groupId: "org_1",
		})
	})
})
