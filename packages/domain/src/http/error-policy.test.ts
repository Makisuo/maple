import { describe, expect, it } from "@effect/vitest"
import * as Http from "./index"

const prop = (value: unknown, key: string): unknown =>
	(typeof value === "object" || typeof value === "function") && value !== null && key in value
		? (value as Record<string, unknown>)[key]
		: undefined

const taggedErrorIdentity = (value: unknown): { readonly tag: string; readonly status: number } | null => {
	const tag = prop(prop(prop(prop(value, "fields"), "_tag"), "schema"), "literal")
	const status = prop(prop(prop(value, "ast"), "annotations"), "httpApiStatus")
	return typeof tag === "string" && typeof status === "number" ? { tag, status } : null
}

describe("HTTP error tag contract", () => {
	it("gives every exported tagged HTTP error one globally unique semantic identity", () => {
		const identities = Object.values(Http)
			.map(taggedErrorIdentity)
			.filter((identity): identity is NonNullable<typeof identity> => identity !== null)
		const tags = identities.map((identity) => identity.tag)

		expect(identities.length).toBeGreaterThan(100)
		expect(new Set(tags).size).toBe(tags.length)
		for (const { tag, status } of identities) {
			expect(tag, "tag is namespaced").toMatch(/^@maple\//)
			expect(status, tag).toBeGreaterThanOrEqual(400)
			expect(status, tag).toBeLessThan(600)
		}
	})
})
