import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { MapleApiV2 } from "./api"
import { V2AlertDestinationMutationResponse } from "./alert-destinations"
import { V2AnomalyIncident, V2AnomalyIncidentTimeseries, V2AnomalySettings } from "./anomalies"
import { V2ApiKey, V2ApiKeyCreateParams, V2ApiKeyMutationResponse, V2ApiKeyWithSecret } from "./api-keys"
import { V2Investigation } from "./investigations"
import { V2Organization } from "./organization"
import { V2SessionReplay, V2SessionReplayListItem } from "./session-replays"

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
			"DELETE /v2/alerts/destinations/{id}",
			"DELETE /v2/alerts/rules/{id}",
			"DELETE /v2/api_keys/{id}",
			"DELETE /v2/attribute_mappings/{id}",
			"DELETE /v2/dashboards/{id}",
			"DELETE /v2/scrape_targets/{id}",
			"GET /v2/alerts/destinations",
			"GET /v2/alerts/destinations/{id}",
			"GET /v2/alerts/incidents",
			"GET /v2/alerts/incidents/{id}",
			"GET /v2/alerts/rules",
			"GET /v2/alerts/rules/{id}",
			"GET /v2/alerts/rules/{id}/checks",
			"GET /v2/anomalies/incidents",
			"GET /v2/anomalies/incidents/{id}",
			"GET /v2/anomalies/incidents/{id}/timeseries",
			"GET /v2/anomalies/settings",
			"GET /v2/api_keys",
			"GET /v2/api_keys/{id}",
			"GET /v2/attribute_mappings",
			"GET /v2/attribute_mappings/{id}",
			"GET /v2/dashboards",
			"GET /v2/dashboards/templates",
			"GET /v2/dashboards/{id}",
			"GET /v2/dashboards/{id}/versions",
			"GET /v2/dashboards/{id}/versions/{versionId}",
			"GET /v2/ingest_keys",
			"GET /v2/instrumentation/recommendations",
			"GET /v2/investigations",
			"GET /v2/investigations/{id}",
			"GET /v2/organization",
			"GET /v2/scrape_targets",
			"GET /v2/scrape_targets/{id}",
			"GET /v2/scrape_targets/{id}/checks",
			"GET /v2/session_replays/{id}",
			"GET /v2/session_replays/{id}/events",
			"GET /v2/session_replays/{id}/transcript",
			"PATCH /v2/alerts/destinations/{id}",
			"PATCH /v2/alerts/rules/{id}",
			"PATCH /v2/attribute_mappings/{id}",
			"PATCH /v2/dashboards/{id}",
			"PATCH /v2/scrape_targets/{id}",
			"POST /v2/alerts/destinations",
			"POST /v2/alerts/destinations/{id}/test",
			"POST /v2/alerts/rules",
			"POST /v2/alerts/rules/preview",
			"POST /v2/alerts/rules/test",
			"POST /v2/anomalies/incidents/{id}/resolve",
			"POST /v2/api_keys",
			"POST /v2/api_keys/{id}/roll",
			"POST /v2/attribute_mappings",
			"POST /v2/dashboards",
			"POST /v2/dashboards/import/perses",
			"POST /v2/dashboards/templates/{templateId}/instantiate",
			"POST /v2/dashboards/{id}/versions/{versionId}/restore",
			"POST /v2/ingest_keys/private/roll",
			"POST /v2/ingest_keys/public/roll",
			"POST /v2/instrumentation/recommendations/{id}/dismiss",
			"POST /v2/instrumentation/recommendations/{id}/reopen",
			"POST /v2/investigations",
			"POST /v2/investigations/{id}/status",
			"POST /v2/scrape_targets",
			"POST /v2/scrape_targets/{id}/probe",
			"POST /v2/session_replays/for_trace",
			"POST /v2/session_replays/search",
			"PUT /v2/anomalies/incidents/{id}/issue",
			"PUT /v2/anomalies/settings",
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

	it("documents the Phase-1 resource schemas with decodable wire examples", () => {
		const cases: ReadonlyArray<readonly [string, Schema.Codec<any, any>, string]> = [
			["Investigation", V2Investigation, "investigation"],
			["AnomalyIncident", V2AnomalyIncident, "anomaly_incident"],
			["AnomalyIncidentTimeseries", V2AnomalyIncidentTimeseries, "anomaly_incident.timeseries"],
			["AnomalySettings", V2AnomalySettings, "anomaly_settings"],
			["Organization", V2Organization, "organization"],
			["SessionReplayListItem", V2SessionReplayListItem, "session_replay"],
			["SessionReplay", V2SessionReplay, "session_replay"],
		]
		for (const [name, schema, objectType] of cases) {
			const component = schemas[name]
			expect(component, `component ${name} present`).toBeDefined()
			expect(component.examples, `${name} has an example`).toHaveLength(1)
			const decoded = Schema.decodeUnknownSync(schema)(component.examples[0]) as { object: string }
			expect(decoded.object).toBe(objectType)
		}
	})

	it("documents alert-destination mutation sync metadata", () => {
		const mutation = schemas["AlertDestinationMutationResponse"]
		expect(() =>
			Schema.decodeUnknownSync(V2AlertDestinationMutationResponse)(mutation.examples[0]),
		).not.toThrow()
		expect(mutation.properties.txid.$ref).toBe("#/components/schemas/_maple_PostgresTransactionId")
		expect(operation("post", "/v2/alerts/destinations").responses["200"]).toBeDefined()
	})

	it("documents the public-ID and Scope primitives with examples", () => {
		expect(schemas["_maple_ApiKeyId"].description).toContain("public object ID")
		expect(schemas["_maple_ApiKeyId"].examples?.[0]).toMatch(/^key_/)
		expect(schemas["Scope"].allOf?.[0]?.examples).toEqual(expect.arrayContaining(["*"]))
	})

	it("generates syntactically valid examples for every public-ID primitive", () => {
		const publicIds = Object.entries(schemas).filter(
			([name, component]) =>
				name.startsWith("_maple_") && JSON.stringify(component).includes("public object ID"),
		)
		expect(publicIds.length).toBeGreaterThan(5)
		for (const [name, component] of publicIds) {
			const examples = [component, ...(component.allOf ?? [])].flatMap((part) => part.examples ?? [])
			expect(examples, `${name} has an example`).toHaveLength(1)
			expect(examples[0], `${name} has a valid prefixed base58 ID`).toMatch(
				/^[a-z]+_[1-9A-HJ-NP-Za-km-z]+$/,
			)
		}
	})

	it("does not advertise ignored list pagination on session-replay retrieve", () => {
		const parameters = operation("get", "/v2/session_replays/{id}").parameters as ReadonlyArray<{
			name: string
		}>
		expect(parameters.map((parameter) => parameter.name).sort()).toEqual([
			"id",
			"window_end",
			"window_start",
		])
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
