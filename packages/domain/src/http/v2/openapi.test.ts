import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { MapleApiV2 } from "./api"
import { V2ApiKey, V2ApiKeyCreateParams, V2ApiKeyMutationResponse, V2ApiKeyWithSecret } from "./api-keys"

/**
 * Contract freeze: the public v2 OpenAPI surface (paths + methods) is asserted
 * explicitly so an accidental route change fails CI. Additions require
 * updating this list — which is the point.
 *
 * Beyond the route surface, we also freeze the *documentation quality* of the
 * pilot `api_keys` resource: operation summaries/descriptions/ids, tag prose,
 * clean component names, schema-level titles/descriptions/examples, and the
 * security scheme. This makes the first endpoint the reference standard and
 * fails CI if a future edit strips the metadata.
 */
const spec = OpenApi.fromApi(MapleApiV2)

// The generated document carries fields (info.contact, top-level externalDocs,
// security bearerFormat, schema examples) beyond the pruned `OpenAPISpec` type,
// so read the dynamic bits through an untyped view.
const doc = spec as unknown as Record<string, any>
const schemas = doc.components.schemas as Record<string, any>
const operation = (method: string, path: string): Record<string, any> =>
	(spec.paths as Record<string, any>)[path][method]

describe("MapleApiV2 OpenAPI", () => {
	it("derives with v2 metadata", () => {
		expect(spec.info.title).toBe("Maple API")
		expect(spec.info.version).toBe("2.0.0")
	})

	it("exposes exactly the committed v2 paths", () => {
		const surface = Object.entries(spec.paths ?? {})
			.flatMap(([path, item]) =>
				Object.keys(item ?? {})
					.filter((key) => ["get", "post", "put", "patch", "delete"].includes(key))
					.map((method) => `${method.toUpperCase()} ${path}`),
			)
			.sort()

		expect(surface).toEqual([
			"DELETE /v2/api_keys/{id}",
			"GET /v2/api_keys",
			"GET /v2/api_keys/{id}",
			"POST /v2/api_keys",
			"POST /v2/api_keys/{id}/roll",
		])
	})

	it("populates the info block: summary, description, contact, servers, external docs", () => {
		expect(doc.info.summary).toEqual(expect.any(String))
		expect(doc.info.description).toContain("resource-oriented")
		expect(doc.info.contact).toEqual({
			name: "Maple Support",
			url: "https://maple.dev",
			email: "support@maple.dev",
		})
		expect(doc.servers).toEqual([{ url: "https://api.maple.dev", description: "Production" }])
		expect(doc.externalDocs?.url).toBe("https://api.maple.dev/v2/docs")
	})

	it("names the group tag and gives it a description", () => {
		const tag = (spec.tags ?? []).find((t) => t.name === "API Keys")
		expect(tag).toBeDefined()
		expect(tag?.description).toEqual(expect.stringContaining("Programmatic credentials"))
	})

	it("gives every operation a stable operationId, summary, and description", () => {
		const expected: ReadonlyArray<readonly [string, string, string]> = [
			["get", "/v2/api_keys", "listApiKeys"],
			["post", "/v2/api_keys", "createApiKey"],
			["get", "/v2/api_keys/{id}", "getApiKey"],
			["post", "/v2/api_keys/{id}/roll", "rollApiKey"],
			["delete", "/v2/api_keys/{id}", "revokeApiKey"],
		]
		for (const [method, path, operationId] of expected) {
			const op = operation(method, path)
			expect(op.operationId).toBe(operationId)
			expect(op.summary).toEqual(expect.any(String))
			expect(op.summary.length).toBeGreaterThan(0)
			expect(op.description.length).toBeGreaterThan(20)
			expect(op.tags).toEqual(["API Keys"])
			expect(op.security).toEqual([{ bearer: [] }])
		}
	})

	it("uses clean, unprefixed component schema names", () => {
		const names = Object.keys(schemas)
		expect(names).toEqual(
			expect.arrayContaining([
				"ApiKey",
				"ApiKeyWithSecret",
				"ApiKeyMutationResponse",
				"ApiKeyCreateParams",
				"ApiKeyList",
				"Scope",
			]),
		)
		expect(names).toEqual(
			expect.arrayContaining([
				"InvalidRequestError",
				"AuthenticationError",
				"PermissionError",
				"NotFoundError",
				"ServiceUnavailableError",
			]),
		)
		// No internal / v2-prefixed / namespaced identifiers leaked into the public spec.
		expect(names.some((n) => n.startsWith("V2") || n.includes("@maple") || n.includes("/"))).toBe(false)
	})

	it("documents the ApiKey schema with a title, description, and a decodable example", () => {
		const apiKey = schemas["ApiKey"]
		expect(apiKey.title).toBe("API Key")
		expect(apiKey.description.length).toBeGreaterThan(20)
		expect(apiKey.examples).toHaveLength(1)
		// The example is authored in wire shape — it must decode through the schema.
		const decoded = Schema.decodeUnknownSync(V2ApiKey)(apiKey.examples[0])
		expect(apiKey.examples[0].id).toMatch(/^key_/)
		expect(decoded.object).toBe("api_key")

		// Field-level docs render too.
		expect(apiKey.properties.name.description).toEqual(expect.any(String))
		expect(apiKey.properties.name.examples).toEqual(["ci-pipeline"])
		expect(apiKey.properties.key_prefix.description).toContain("secret")
	})

	it("documents ApiKeyWithSecret and ApiKeyCreateParams with decodable examples", () => {
		const withSecret = schemas["ApiKeyWithSecret"]
		expect(withSecret.title).toBe("API Key (with secret)")
		expect(withSecret.properties.secret.description).toContain("once")
		expect(() => Schema.decodeUnknownSync(V2ApiKeyWithSecret)(withSecret.examples[0])).not.toThrow()
		expect(withSecret.properties.txid.$ref).toBe("#/components/schemas/_maple_PostgresTransactionId")
		expect(schemas["_maple_PostgresTransactionId"].allOf).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ description: expect.stringContaining("reconcile") }),
			]),
		)

		const mutation = schemas["ApiKeyMutationResponse"]
		expect(() => Schema.decodeUnknownSync(V2ApiKeyMutationResponse)(mutation.examples[0])).not.toThrow()

		const createParams = schemas["ApiKeyCreateParams"]
		expect(createParams.examples).toHaveLength(1)
		expect(() => Schema.decodeUnknownSync(V2ApiKeyCreateParams)(createParams.examples[0])).not.toThrow()
	})

	it("documents the public-ID and Scope primitives with examples", () => {
		expect(schemas["_maple_ApiKeyId"].description).toContain("public object ID")
		expect(schemas["_maple_ApiKeyId"].examples?.[0]).toMatch(/^key_/)
		expect(schemas["Scope"].allOf?.[0]?.examples).toEqual(expect.arrayContaining(["*"]))
	})

	it("documents the bearer security scheme with a description and bearer format", () => {
		const bearer = doc.components.securitySchemes.bearer
		expect(bearer.type).toBe("http")
		expect(bearer.scheme).toBe("Bearer")
		expect(bearer.description).toContain("maple_ak_")
		expect(bearer.bearerFormat.length).toBeGreaterThan(0)
	})

	it("documents error responses with a stable code example", () => {
		const notFound = schemas["NotFoundError"]
		expect(notFound.properties.error.properties.code.examples).toEqual(["resource_missing"])
		expect(notFound.properties.error.properties.message.description).toEqual(expect.any(String))
	})
})
