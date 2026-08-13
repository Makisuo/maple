import { describe, expect, it } from "@effect/vitest"
import { OpenApi } from "effect/unstable/httpapi"
import * as Http from "./index"

const prop = (value: unknown, key: string): unknown =>
	(typeof value === "object" || typeof value === "function") && value !== null && key in value
		? (value as Record<string, unknown>)[key]
		: undefined

interface TaggedErrorIdentity {
	readonly name: string
	readonly tag: string
	readonly status: number
	readonly hasMessage: boolean
}

const taggedErrorIdentity = (name: string, value: unknown): TaggedErrorIdentity | null => {
	const tag = prop(prop(prop(prop(value, "fields"), "_tag"), "schema"), "literal")
	const status = prop(prop(prop(value, "ast"), "annotations"), "httpApiStatus")
	const hasMessage =
		prop(value, "fields") !== undefined && prop(prop(value, "fields"), "message") !== undefined
	return typeof tag === "string" && typeof status === "number" ? { name, tag, status, hasMessage } : null
}

describe("HTTP error tag contract", () => {
	it("gives every exported tagged HTTP error one globally unique semantic identity", () => {
		const identities = Object.entries(Http)
			.map(([name, value]) => taggedErrorIdentity(name, value))
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

	it("gives every tagged HTTP error a useful message and stable status semantics", () => {
		const identities = Object.entries(Http)
			.map(([name, value]) => taggedErrorIdentity(name, value))
			.filter((identity): identity is NonNullable<typeof identity> => identity !== null)

		for (const identity of identities) {
			expect(identity.hasMessage, `${identity.name} has a message field`).toBe(true)

			if (identity.name.endsWith("ValidationError")) {
				expect(identity.status, identity.name).toBe(400)
			}
			if (identity.name.endsWith("ForbiddenError")) {
				expect(identity.status, identity.name).toBe(403)
			}
			if (identity.name.endsWith("NotFoundError")) {
				expect(identity.status, identity.name).toBe(404)
			}
			if (identity.name.endsWith("PersistenceError")) {
				expect(identity.status, identity.name).toBe(503)
			}
			if (/RateLimitError$|QuotaError$|QuotaExceededError$/.test(identity.name)) {
				expect(identity.status, identity.name).toBe(429)
			}
			if (/ConflictError$|ConcurrencyError$|InUseError$/.test(identity.name)) {
				expect(identity.status, identity.name).toBe(409)
			}
		}
	})

	it("declares the shared request-validation and unexpected-error boundary on every v1 operation", () => {
		const spec = OpenApi.fromApi(Http.MapleApi)
		const operations = Object.entries(spec.paths ?? {}).flatMap(([path, item]) =>
			Object.entries(item ?? {})
				.filter(([method]) => ["get", "post", "put", "patch", "delete"].includes(method))
				.map(([method, operation]) => ({
					method,
					path,
					operation: operation as { readonly responses?: Record<string, unknown> },
				})),
		)

		for (const { method, path, operation } of operations) {
			for (const status of ["400", "500"]) {
				expect(
					operation.responses?.[status],
					`${method.toUpperCase()} ${path} declares ${status}`,
				).toBeDefined()
			}
		}
	})
})
