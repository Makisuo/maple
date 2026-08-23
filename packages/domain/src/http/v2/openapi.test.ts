import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { SlackBotAlertDestinationConfig, UpdateSlackBotAlertDestinationConfig } from "../alerts"
import { MapleApiV2 } from "./api"
import {
	V2AlertDestinationCreateParams,
	V2AlertDestinationMutationResponse,
	V2AlertDestinationUpdateParams,
} from "./alert-destinations"
import { V2SlackChannel, V2SlackChannelList, V2SlackIntegrationStatus } from "./integrations"
import { V2AnomalyIncident, V2AnomalyIncidentTimeseries, V2AnomalySettings } from "./anomalies"
import { V2ApiKey, V2ApiKeyCreateParams, V2ApiKeyMutationResponse, V2ApiKeyWithSecret } from "./api-keys"
import { V2Investigation } from "./investigations"
import { V2Organization } from "./organization"
import { V2SessionReplay, V2SessionReplayListItem } from "./session-replays"
import { errorTypeForStatus } from "./errors"

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
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type, maple/no-record-string-any, typescript/no-explicit-any -- Effect's public OpenAPI type intentionally omits generated extension fields asserted by this contract test.
type GeneratedOpenApiObject = Record<string, any>
const doc = spec as GeneratedOpenApiObject
const schemas = doc.components.schemas as GeneratedOpenApiObject
const operation = (method: string, path: string): GeneratedOpenApiObject =>
	(spec.paths as GeneratedOpenApiObject)[path][method]
const resolveSchema = (schema: GeneratedOpenApiObject): GeneratedOpenApiObject => {
	const ref = schema.$ref as string | undefined
	return ref === undefined ? schema : schemas[ref.slice(ref.lastIndexOf("/") + 1)]
}
const schemaBranches = (schema: GeneratedOpenApiObject): ReadonlyArray<GeneratedOpenApiObject> => {
	const resolved = resolveSchema(schema)
	const alternatives = (resolved.anyOf ?? resolved.oneOf) as
		| ReadonlyArray<GeneratedOpenApiObject>
		| undefined
	return alternatives === undefined ? [resolved] : alternatives.flatMap(schemaBranches)
}
const responseErrorTags = (method: string, path: string, status: string): ReadonlyArray<string> => {
	const response = operation(method, path).responses[status] as GeneratedOpenApiObject
	const responseSchema = response.content["application/json"].schema as GeneratedOpenApiObject
	return schemaBranches(responseSchema).map((branch) => {
		const tag = resolveSchema(branch).properties.error.properties._tag
		expect(tag.type).toBe("string")
		expect(tag.enum).toHaveLength(1)
		return tag.enum[0] as string
	})
}

const OpenApiOperationMetadata = Schema.Struct({
	operationId: Schema.String,
	summary: Schema.String,
	description: Schema.String,
	tags: Schema.Array(Schema.String),
	security: Schema.Array(Schema.Record(Schema.String, Schema.Array(Schema.String))),
	responses: Schema.Record(Schema.String, Schema.Unknown),
})
const decodeOperationMetadata = Schema.decodeUnknownSync(OpenApiOperationMetadata)
const decodeParameterNames = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))

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
			"DELETE /v2/dashboards/{id}/share",
			"DELETE /v2/dashboards/{id}/widgets/{widget_id}/share",
			"DELETE /v2/integrations/planetscale",
			"DELETE /v2/integrations/slack",
			"DELETE /v2/mobile_devices/{token}",
			"DELETE /v2/mobile_devices/{token}/live_activities/{incident_id}",
			"DELETE /v2/scrape_targets/{id}",
			"DELETE /v2/widget_credentials/{installation_id}",
			"GET /v2/alerts/deliveries",
			"GET /v2/alerts/destinations",
			"GET /v2/alerts/destinations/{id}",
			"GET /v2/alerts/incidents",
			"GET /v2/alerts/incidents/{id}",
			"GET /v2/alerts/rules",
			"GET /v2/alerts/rules/{id}",
			"GET /v2/alerts/rules/{id}/checks",
			"GET /v2/alerts/rules/{id}/checks/summary",
			"GET /v2/anomalies/incidents",
			"GET /v2/anomalies/incidents/service_counts",
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
			"GET /v2/dashboards/{id}/share",
			"GET /v2/dashboards/{id}/shares",
			"GET /v2/dashboards/{id}/versions",
			"GET /v2/dashboards/{id}/versions/{version_id}",
			"GET /v2/dashboards/{id}/widgets/{widget_id}/share",
			"GET /v2/error_issues",
			"GET /v2/error_issues/service_counts",
			"GET /v2/error_issues/{id}",
			"GET /v2/ingest_keys",
			"GET /v2/instrumentation/audit",
			"GET /v2/instrumentation/recommendations",
			"GET /v2/integrations/planetscale",
			"GET /v2/integrations/planetscale/databases",
			"GET /v2/integrations/planetscale/organizations",
			"GET /v2/integrations/planetscale/webhook_config",
			"GET /v2/integrations/slack",
			"GET /v2/integrations/slack/channels",
			"GET /v2/investigations",
			"GET /v2/investigations/{id}",
			"GET /v2/logs/{id}",
			"GET /v2/metrics",
			"GET /v2/mobile_devices",
			"GET /v2/organization",
			"GET /v2/scrape_targets",
			"GET /v2/scrape_targets/{id}",
			"GET /v2/scrape_targets/{id}/checks",
			"GET /v2/service_map",
			"GET /v2/services",
			"GET /v2/services/{name}",
			"GET /v2/session_replays/{id}",
			"GET /v2/session_replays/{id}/events",
			"GET /v2/session_replays/{id}/manifest",
			"GET /v2/session_replays/{id}/transcript",
			"GET /v2/traces/{trace_id}",
			"GET /v2/traces/{trace_id}/spans/{span_id}",
			"GET /v2/widget_summary",
			"PATCH /v2/alerts/destinations/{id}",
			"PATCH /v2/alerts/rules/{id}",
			"PATCH /v2/anomalies/settings",
			"PATCH /v2/attribute_mappings/{id}",
			"PATCH /v2/dashboards/{id}",
			"PATCH /v2/scrape_targets/{id}",
			"POST /v2/alerts/destinations",
			"POST /v2/alerts/destinations/telegram/chats",
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
			"POST /v2/dashboards/templates/{template_id}/instantiate",
			"POST /v2/dashboards/templates/{template_id}/preview",
			"POST /v2/dashboards/{id}/share/rotate",
			"POST /v2/dashboards/{id}/versions/{version_id}/restore",
			"POST /v2/dashboards/{id}/widgets/{widget_id}/share/rotate",
			"POST /v2/ingest_keys/private/roll",
			"POST /v2/ingest_keys/public/roll",
			"POST /v2/instrumentation/recommendations/{id}/dismiss",
			"POST /v2/instrumentation/recommendations/{id}/reopen",
			"POST /v2/integrations/planetscale/connect",
			"POST /v2/integrations/planetscale/events",
			"POST /v2/integrations/planetscale/metrics_token",
			"POST /v2/integrations/planetscale/query_insights",
			"POST /v2/integrations/planetscale/select_organization",
			"POST /v2/integrations/slack/install",
			"POST /v2/investigations",
			"POST /v2/investigations/{id}/restart",
			"POST /v2/investigations/{id}/status",
			"POST /v2/logs/breakdown",
			"POST /v2/logs/search",
			"POST /v2/logs/timeseries",
			"POST /v2/metrics/breakdown",
			"POST /v2/metrics/timeseries",
			"POST /v2/scrape_targets",
			"POST /v2/scrape_targets/{id}/probe",
			"POST /v2/session_replays/for_trace",
			"POST /v2/session_replays/search",
			"POST /v2/share/alert-chart",
			"POST /v2/share/og-card",
			"POST /v2/share/og-meta",
			"POST /v2/share/resolve",
			"POST /v2/share/widget-data",
			"POST /v2/traces/breakdown",
			"POST /v2/traces/search",
			"POST /v2/traces/timeseries",
			"PUT /v2/anomalies/incidents/{id}/issue",
			"PUT /v2/dashboards/{id}/share",
			"PUT /v2/dashboards/{id}/widgets/{widget_id}/share",
			"PUT /v2/mobile_devices/{token}",
			"PUT /v2/mobile_devices/{token}/live_activities/{incident_id}",
			"PUT /v2/widget_credentials/{installation_id}",
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

	/**
	 * Operations served without a bearer credential.
	 *
	 * An allowlist by operationId, not a path prefix or a group check: the point
	 * is that a further unauthenticated operation cannot appear in this API
	 * without someone editing this constant. Share links are the only case — the
	 * token in the request body *is* the credential, and requiring a bearer
	 * alongside it would mean the link only worked for people who did not need it.
	 *
	 * The two OG operations are the same surface seen from the crawler side: one
	 * is the page worker asking what tags to inline for a link, the other is the
	 * preview image asking what to draw for a signed image id. Neither can be
	 * bearer-authenticated, because the caller is a link preview.
	 *
	 * These still carry every other operation guarantee below, and every common
	 * error envelope except `401`, which they cannot emit.
	 */
	const PUBLIC_OPERATION_IDS: ReadonlySet<string> = new Set([
		"resolveShare",
		"resolveShareWidgetData",
		"resolveShareOgMeta",
		"resolveShareOgCard",
		"resolveAlertChart",
	])

	/**
	 * The public operations that still *consult* a session when one is present,
	 * which is what makes "wrong organization" an answer they can give.
	 */
	const SESSION_READING_PUBLIC_OPERATION_IDS: ReadonlySet<string> = new Set([
		"resolveShare",
		"resolveShareWidgetData",
	])

	it("gives every operation complete metadata, security, and common error envelopes", () => {
		const operations = Object.entries(spec.paths ?? {}).flatMap(([path, item]) =>
			Object.entries(item ?? {})
				.filter(([method]) => ["get", "post", "put", "patch", "delete"].includes(method))
				.map(([method, op]) => ({ method, path, op: decodeOperationMetadata(op) })),
		)
		const operationIds = new Set<string>()
		for (const { method, path, op } of operations) {
			expect(op.operationId, `${method.toUpperCase()} ${path} operationId`).toEqual(expect.any(String))
			expect(operationIds.has(op.operationId), `${op.operationId} is unique`).toBe(false)
			operationIds.add(op.operationId)
			expect(op.summary).toEqual(expect.any(String))
			expect(op.summary.length).toBeGreaterThan(0)
			expect(op.description.length).toBeGreaterThan(20)
			expect(op.tags).toHaveLength(1)
			const isPublic = PUBLIC_OPERATION_IDS.has(op.operationId)
			expect(op.security, `${op.operationId} security`).toEqual(isPublic ? [] : [{ bearer: [] }])
			// 401 and 403 describe a credential being rejected, so an operation only
			// declares them if presenting one can change its answer. Every authed
			// operation can; among the public ones, only the two that read an
			// optional session to decide whether an org-only link opens. The OG
			// operations answer a link preview, which has no credential to present
			// and no way to acquire one, so for them those statuses would be
			// unreachable documentation.
			const readsSession = SESSION_READING_PUBLIC_OPERATION_IDS.has(op.operationId)
			const commonStatuses = !isPublic
				? ["400", "401", "403", "429", "500", "504"]
				: readsSession
					? ["400", "403", "429", "500", "504"]
					: ["400", "429", "500", "504"]
			for (const status of commonStatuses) {
				expect(
					op.responses[status],
					`${method.toUpperCase()} ${path} declares ${status}`,
				).toBeDefined()
			}
			const rateLimitResponse = op.responses["429"] as GeneratedOpenApiObject
			expect(rateLimitResponse.headers?.["Retry-After"]).toMatchObject({
				description: expect.any(String),
				schema: {
					oneOf: [{ type: "integer", minimum: 1 }, { type: "string" }],
				},
				example: 60,
			})
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
				"InvalidCredentialsError",
				"InsufficientScopeError",
				"ApiKeyNotFoundError",
				"RateLimitError",
				"ApiKeyPersistenceError",
			]),
		)
		// No internal / v2-prefixed / namespaced identifiers leaked into the public spec.
		expect(names.some((n) => n.startsWith("V2") || n.includes("@maple") || n.includes("/"))).toBe(false)
	})

	it("freezes the signal-scoped telemetry operations, examples, and result schemas", () => {
		expect(spec.paths?.["/v2/query"]).toBeUndefined()
		for (const [path, operationId, resultSchema] of [
			["/v2/traces/timeseries", "queryTraceTimeseries", "TraceTimeseriesResult"],
			["/v2/traces/breakdown", "queryTraceBreakdown", "TraceBreakdownResult"],
			["/v2/logs/timeseries", "queryLogTimeseries", "LogTimeseriesResult"],
			["/v2/logs/breakdown", "queryLogBreakdown", "LogBreakdownResult"],
			["/v2/metrics/timeseries", "queryMetricsTimeseries", "MetricTimeseriesResult"],
			["/v2/metrics/breakdown", "queryMetricBreakdown", "MetricBreakdownResult"],
		] as const) {
			const op = operation("post", path)
			expect(op.operationId).toBe(operationId)
			expect(op.responses["200"].content["application/json"].schema.$ref).toBe(
				`#/components/schemas/${resultSchema}`,
			)
			expect(schemas[resultSchema].examples).toHaveLength(1)
		}
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
				expect.objectContaining({ description: expect.stringContaining("reconciliation") }),
			]),
		)

		const mutation = schemas["ApiKeyMutationResponse"]
		expect(() => Schema.decodeUnknownSync(V2ApiKeyMutationResponse)(mutation.examples[0])).not.toThrow()

		const createParams = schemas["ApiKeyCreateParams"]
		expect(createParams.examples).toHaveLength(1)
		expect(() => Schema.decodeUnknownSync(V2ApiKeyCreateParams)(createParams.examples[0])).not.toThrow()
	})

	it("documents the Phase-1 resource schemas with decodable wire examples", () => {
		const cases = [
			["Investigation", Schema.decodeUnknownSync(V2Investigation), "investigation"],
			["AnomalyIncident", Schema.decodeUnknownSync(V2AnomalyIncident), "anomaly_incident"],
			[
				"AnomalyIncidentTimeseries",
				Schema.decodeUnknownSync(V2AnomalyIncidentTimeseries),
				"anomaly_incident.timeseries",
			],
			["AnomalySettings", Schema.decodeUnknownSync(V2AnomalySettings), "anomaly_settings"],
			["Organization", Schema.decodeUnknownSync(V2Organization), "organization"],
			["SessionReplayListItem", Schema.decodeUnknownSync(V2SessionReplayListItem), "session_replay"],
			["SessionReplay", Schema.decodeUnknownSync(V2SessionReplay), "session_replay"],
		] as const
		for (const [name, decode, objectType] of cases) {
			const component = schemas[name]
			expect(component, `component ${name} present`).toBeDefined()
			expect(component.examples, `${name} has an example`).toHaveLength(1)
			const decoded = decode(component.examples[0])
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

	it("documents the Slack integration schemas with decodable wire examples", () => {
		const status = schemas["SlackIntegration"]
		expect(status, "SlackIntegration component present").toBeDefined()
		expect(status.examples).toHaveLength(1)
		const decodedStatus = Schema.decodeUnknownSync(V2SlackIntegrationStatus)(status.examples[0])
		expect(decodedStatus.object).toBe("slack_integration")
		expect(decodedStatus.installed).toBe(true)
		expect(decodedStatus.team_id).toBe("T0123ABCD")

		const channel = schemas["SlackChannel"]
		expect(channel, "SlackChannel component present").toBeDefined()
		expect(channel.examples).toHaveLength(1)
		const decodedChannel = Schema.decodeUnknownSync(V2SlackChannel)(channel.examples[0])
		expect(decodedChannel.id).toBe("C0789CHAN")
		expect(decodedChannel.is_private).toBe(false)

		const list = schemas["SlackChannelList"]
		expect(list, "SlackChannelList component present").toBeDefined()
		expect(list.examples).toHaveLength(1)
		const decodedList = Schema.decodeUnknownSync(V2SlackChannelList)(list.examples[0])
		expect(decodedList.object).toBe("slack_integration.channel_list")
		expect(decodedList.channels[0]?.id).toBe("C0789CHAN")
	})

	it("narrows the Slack operations to the errors their handlers can actually return", () => {
		// Per-endpoint error lists replaced a shared `commonErrors` tuple: a wider
		// list would document responses the API can never produce.
		const declared = (method: string, path: string) =>
			Object.keys(operation(method, path).responses).sort()

		// 400/401/403/429/500/504 come from shared boundaries; 503 from the handlers.
		expect(declared("get", "/v2/integrations/slack")).toEqual([
			"200",
			"400",
			"401",
			"403",
			"429",
			"500",
			"503",
			"504",
		])
		expect(declared("post", "/v2/integrations/slack/install")).toEqual([
			"200",
			"400",
			"401",
			"403",
			"429",
			"500",
			"503",
			"504",
		])
		expect(declared("delete", "/v2/integrations/slack")).toEqual([
			"200",
			"400",
			"401",
			"403",
			"429",
			"500",
			"503",
			"504",
		])
		// Only `channels` can 409 (not connected) or 502 (Slack rejected us).
		expect(declared("get", "/v2/integrations/slack/channels")).toEqual([
			"200",
			"400",
			"401",
			"403",
			"409",
			"429",
			"500",
			"502",
			"503",
			"504",
		])
	})

	it("documents the distinct scope and org-admin tags on Slack operations", () => {
		// install / uninstall / channels all call `requireAdmin`: `channels`
		// enumerates the workspace's channels, private ones included, so it is not
		// something any org member may read.
		const adminTags = [
			"@maple/http/v2/InsufficientPermissionsError",
			"@maple/http/v2/InsufficientScopeError",
			// From `AuthorizationV2` itself, so every v2 operation carries it: a request
			// can always name an organization (`x-maple-org-id`) the caller is not in.
			"@maple/http/v2/OrganizationAccessDeniedError",
		]
		expect([...responseErrorTags("post", "/v2/integrations/slack/install", "403")].sort()).toEqual(
			adminTags,
		)
		expect([...responseErrorTags("delete", "/v2/integrations/slack", "403")].sort()).toEqual(adminTags)
		expect([...responseErrorTags("get", "/v2/integrations/slack/channels", "403")].sort()).toEqual(
			adminTags,
		)
		expect(operation("get", "/v2/integrations/slack/channels").description).toContain("org-admin")

		// `status` stays UNGATED — the dashboard's Slack card renders install state
		// for every member, so its 403 comes from the scope middleware alone.
		expect(responseErrorTags("get", "/v2/integrations/slack", "403")).toEqual([
			"@maple/http/v2/InsufficientScopeError",
			// From `AuthorizationV2` itself, so every v2 operation carries it: a request
			// can always name an organization (`x-maple-org-id`) the caller is not in.
			"@maple/http/v2/OrganizationAccessDeniedError",
		])
	})

	it("gives every error response an exhaustive literal-tag union", () => {
		for (const [path, item] of Object.entries(spec.paths ?? {})) {
			for (const [method, candidate] of Object.entries(item ?? {})) {
				if (!["get", "post", "put", "patch", "delete"].includes(method)) continue
				const op = candidate as GeneratedOpenApiObject
				for (const status of Object.keys(op.responses)) {
					if (Number(status) < 400) continue
					const response = (candidate as GeneratedOpenApiObject).responses[
						status
					] as GeneratedOpenApiObject
					const responseSchema = response.content["application/json"]
						.schema as GeneratedOpenApiObject
					const branches = schemaBranches(responseSchema)
					const tags = responseErrorTags(method, path, status)
					expect(tags.length, `${method.toUpperCase()} ${path} ${status} has tags`).toBeGreaterThan(
						0,
					)
					expect(
						new Set(tags).size,
						`${method.toUpperCase()} ${path} ${status} tags are unique`,
					).toBe(tags.length)
					for (const tag of tags) {
						expect(tag, `${method.toUpperCase()} ${path} ${status} tag`).toMatch(
							/^@maple\/http\//,
						)
					}
					for (const branch of branches) {
						const envelope = resolveSchema(branch)
						const body = envelope.properties.error as GeneratedOpenApiObject
						const label = `${method.toUpperCase()} ${path} ${status}`
						expect(envelope.required, `${label} envelope fields`).toEqual(["error"])
						expect(envelope.additionalProperties, `${label} envelope is closed`).toBe(false)
						expect(body.required, `${label} body fields`).toEqual([
							"_tag",
							"type",
							"code",
							"title",
							"message",
							"retryable",
							"recovery",
						])
						expect(body.additionalProperties, `${label} body is closed`).toBe(false)
						for (const field of ["_tag", "type", "code", "title", "retryable", "recovery"]) {
							expect(body.properties[field].enum, `${label} ${field} is exact`).toHaveLength(1)
						}
						expect(body.properties.message.type, `${label} message`).toBe("string")
						expect(body.properties.type.enum, `${label} status category`).toEqual([
							errorTypeForStatus(
								Number(status) as
									| 400
									| 401
									| 403
									| 404
									| 409
									| 413
									| 429
									| 500
									| 502
									| 503
									| 504,
							),
						])
					}
				}
			}
		}
	})

	it("publishes operation-specific tags for previously collapsed failures", () => {
		expect(responseErrorTags("get", "/v2/api_keys/{id}", "404")).toEqual([
			"@maple/http/errors/ApiKeyNotFoundError",
		])
		expect(responseErrorTags("get", "/v2/integrations/planetscale/organizations", "401")).toEqual([
			"@maple/http/errors/IntegrationsRevokedError",
			"@maple/http/v2/InvalidCredentialsError",
			"@maple/http/errors/UnauthorizedError",
		])
		expect(responseErrorTags("get", "/v2/session_replays/{id}/events", "413")).toEqual([
			"@maple/http/v2/SessionReplayRangeTooLargeError",
		])
		expect(responseErrorTags("post", "/v2/alerts/rules/test", "429")).toEqual([
			"@maple/http/errors/WarehouseQuotaExceededError",
			"@maple/http/v2/RateLimitError",
		])
		expect(responseErrorTags("post", "/v2/traces/timeseries", "500")).toEqual([
			"@maple/http/errors/WarehouseMalformedQueryError",
			"@maple/http/errors/WarehouseScopeError",
			"@maple/http/errors/OrgClickHouseSettingsEncryptionError",
			"@maple/http/errors/QueryEngineResultMismatchError",
			"@maple/http/v2/ResponseSchemaError",
			"@maple/http/v2/UnexpectedError",
		])
	})

	it("does not advertise service errors that v2 handlers cannot emit", () => {
		const serializedSpec = JSON.stringify(spec)
		expect(serializedSpec).not.toContain("@maple/http/errors/QueryEngineExecutionError")
		expect(serializedSpec).not.toContain("@maple/http/errors/WarehouseValidationError")
		expect(responseErrorTags("post", "/v2/api_keys", "403")).toEqual([
			"@maple/http/v2/InsufficientPermissionsError",
			"@maple/http/v2/InsufficientScopeError",
			// From `AuthorizationV2` itself, so every v2 operation carries it: a request
			// can always name an organization (`x-maple-org-id`) the caller is not in.
			"@maple/http/v2/OrganizationAccessDeniedError",
		])
		expect(responseErrorTags("get", "/v2/ingest_keys", "403")).toEqual([
			"@maple/http/v2/InsufficientPermissionsError",
			"@maple/http/v2/InsufficientScopeError",
			// From `AuthorizationV2` itself, so every v2 operation carries it: a request
			// can always name an organization (`x-maple-org-id`) the caller is not in.
			"@maple/http/v2/OrganizationAccessDeniedError",
		])
	})

	it("preserves exact PlanetScale token failures on scrape probes", () => {
		const path = "/v2/scrape_targets/{id}/probe"
		expect(responseErrorTags("post", path, "409")).toContain(
			"@maple/http/errors/IntegrationsNotConnectedError",
		)
		expect(responseErrorTags("post", path, "401")).toContain(
			"@maple/http/errors/IntegrationsRevokedError",
		)
		expect(responseErrorTags("post", path, "502")).toContain(
			"@maple/http/errors/IntegrationsUpstreamError",
		)
		const declaredTags = ["400", "401", "409", "500", "502", "503"].flatMap((status) =>
			responseErrorTags("post", path, status),
		)
		expect(declaredTags).not.toContain("@maple/http/errors/ScrapeTargetAuthError")
	})

	it("preserves managed scrape-target failures on PlanetScale mutations", () => {
		for (const path of [
			"/v2/integrations/planetscale/select_organization",
			"/v2/integrations/planetscale/metrics_token",
		]) {
			expect(responseErrorTags("post", path, "400")).toContain(
				"@maple/http/errors/ScrapeTargetValidationError",
			)
			expect(responseErrorTags("post", path, "404")).toContain(
				"@maple/http/errors/ScrapeTargetNotFoundError",
			)
			expect(responseErrorTags("post", path, "500")).toContain(
				"@maple/http/errors/ScrapeTargetEncryptionError",
			)
			expect(responseErrorTags("post", path, "502")).toContain(
				"@maple/http/errors/ScrapeTargetStoredConfigInvalidError",
			)
			expect(responseErrorTags("post", path, "503")).toContain(
				"@maple/http/errors/ScrapeTargetPersistenceError",
			)
		}
		expect(responseErrorTags("delete", "/v2/integrations/planetscale", "503")).toContain(
			"@maple/http/errors/ScrapeTargetPersistenceError",
		)
	})

	it("distinguishes malformed stored scrape targets from persistence outages", () => {
		for (const [method, path] of [
			["get", "/v2/scrape_targets"],
			["get", "/v2/scrape_targets/{id}"],
			["patch", "/v2/scrape_targets/{id}"],
		] as const) {
			expect(responseErrorTags(method, path, "502"), path).toContain(
				"@maple/http/errors/ScrapeTargetStoredConfigInvalidError",
			)
		}
		expect(operation("post", "/v2/scrape_targets").responses["502"]).toBeUndefined()
		expect(responseErrorTags("get", "/v2/integrations/planetscale", "502")).toContain(
			"@maple/http/errors/ScrapeTargetStoredConfigInvalidError",
		)
	})

	it("preserves warehouse failures on v2 read-model endpoints", () => {
		for (const [method, path] of [
			["get", "/v2/error_issues"],
			["get", "/v2/error_issues/{id}"],
			["get", "/v2/anomalies/incidents/{id}/timeseries"],
		] as const) {
			expect(responseErrorTags(method, path, "429")).toContain(
				"@maple/http/errors/WarehouseQuotaExceededError",
			)
			expect(responseErrorTags(method, path, "503")).toContain(
				"@maple/http/errors/OrgClickHouseSettingsPersistenceError",
			)
			const declaredTags = ["400", "401", "403", "404", "409", "429", "500", "502", "503", "504"]
				.filter((status) => operation(method, path).responses[status] !== undefined)
				.flatMap((status) => responseErrorTags(method, path, status))
			expect(declaredTags, path).not.toContain("@maple/http/errors/TinybirdOrgTokenConfigError")
			expect(declaredTags, path).not.toContain("@maple/http/errors/TinybirdOrgTokenMintError")
			expect(declaredTags, path).not.toContain("@maple/http/errors/WarehouseValidationError")
			expect(declaredTags, path).toContain("@maple/http/errors/WarehouseScopeError")
		}
		for (const path of ["/v2/alerts/rules/{id}/checks", "/v2/alerts/rules/{id}/checks/summary"]) {
			expect(responseErrorTags("get", path, "429")).toContain(
				"@maple/http/errors/WarehouseQuotaExceededError",
			)
			const declaredTags = ["500", "502", "503"].flatMap((status) =>
				responseErrorTags("get", path, status),
			)
			for (const impossibleRoutingTag of [
				"@maple/http/errors/OrgClickHouseSettingsPersistenceError",
				"@maple/http/errors/OrgClickHouseSettingsEncryptionError",
				"@maple/http/errors/OrgClickHouseSettingsStoredConfigInvalidError",
				"@maple/http/errors/TinybirdOrgTokenConfigError",
				"@maple/http/errors/TinybirdOrgTokenMintError",
			]) {
				expect(declaredTags, path).not.toContain(impossibleRoutingTag)
			}
		}
	})

	it("declares exact alert not-found and query-engine failures", () => {
		expect(responseErrorTags("post", "/v2/alerts/rules", "404")).toEqual([
			"@maple/http/errors/AlertRuleDestinationNotFoundError",
		])
		expect(responseErrorTags("get", "/v2/alerts/rules/{id}", "404")).toEqual([
			"@maple/http/errors/AlertRuleNotFoundError",
		])
		expect(responseErrorTags("patch", "/v2/alerts/rules/{id}", "404")).toEqual([
			"@maple/http/errors/AlertRuleNotFoundError",
			"@maple/http/errors/AlertRuleDestinationNotFoundError",
		])
		expect(responseErrorTags("post", "/v2/alerts/rules/test", "404")).toEqual([
			"@maple/http/errors/AlertRuleDestinationNotFoundError",
		])
		expect(responseErrorTags("get", "/v2/alerts/destinations/{id}", "404")).toEqual([
			"@maple/http/errors/AlertDestinationNotFoundError",
		])
		expect(responseErrorTags("get", "/v2/alerts/incidents/{id}", "404")).toEqual([
			"@maple/http/errors/AlertIncidentNotFoundError",
		])
		expect(responseErrorTags("post", "/v2/alerts/rules/preview", "502")).not.toContain(
			"@maple/http/errors/QueryEngineExecutionError",
		)
		expect(responseErrorTags("post", "/v2/alerts/rules/preview", "502")).not.toContain(
			"@maple/http/errors/AlertDeliveryError",
		)
		expect(responseErrorTags("post", "/v2/alerts/rules/preview", "504")).toContain(
			"@maple/http/errors/QueryEngineTimeoutError",
		)
		expect(responseErrorTags("post", "/v2/alerts/rules/preview", "500")).toContain(
			"@maple/http/errors/TinybirdOrgTokenConfigError",
		)
		for (const [method, path] of [
			["get", "/v2/alerts/rules"],
			["get", "/v2/alerts/rules/{id}"],
			["patch", "/v2/alerts/rules/{id}"],
			["delete", "/v2/alerts/destinations/{id}"],
		] as const) {
			expect(responseErrorTags(method, path, "500")).toContain(
				"@maple/http/errors/AlertRuleStoredConfigInvalidError",
			)
		}
	})

	it("distinguishes corrupt stored dashboards from persistence outages", () => {
		for (const [method, path] of [
			["get", "/v2/dashboards"],
			["get", "/v2/dashboards/{id}"],
			["patch", "/v2/dashboards/{id}"],
			["get", "/v2/dashboards/{id}/versions"],
			["get", "/v2/dashboards/{id}/versions/{version_id}"],
			["post", "/v2/dashboards/{id}/versions/{version_id}/restore"],
		] as const) {
			expect(responseErrorTags(method, path, "500"), path).toContain(
				"@maple/http/errors/DashboardStoredConfigInvalidError",
			)
		}

		for (const [method, path] of [
			["delete", "/v2/dashboards/{id}"],
			["post", "/v2/dashboards"],
			["post", "/v2/dashboards/import/perses"],
			["post", "/v2/dashboards/templates/{template_id}/instantiate"],
			["get", "/v2/dashboards/templates"],
			["post", "/v2/dashboards/templates/{template_id}/preview"],
		] as const) {
			const tags = Object.keys(operation(method, path).responses)
				.filter((status) => Number(status) >= 400)
				.flatMap((status) => responseErrorTags(method, path, status))
			expect(tags, path).not.toContain("@maple/http/errors/DashboardStoredConfigInvalidError")
		}
	})

	it("keeps automatic-investigation policy errors off manual endpoints", () => {
		for (const [method, path] of [
			["post", "/v2/investigations"],
			["post", "/v2/investigations/{id}/restart"],
		] as const) {
			const tags = Object.keys(operation(method, path).responses)
				.filter((status) => Number(status) >= 400)
				.flatMap((status) => responseErrorTags(method, path, status))
			for (const impossibleTag of [
				"@maple/http/investigations/InvestigationQuotaError",
				"@maple/http/investigations/InvestigationAutomationDisabledError",
				"@maple/http/investigations/InvestigationRejectedError",
			]) {
				expect(tags, path).not.toContain(impossibleTag)
			}
		}
	})

	it("preserves Hazel provisioning failures on alert destination mutations", () => {
		for (const [method, path] of [
			["post", "/v2/alerts/destinations"],
			["patch", "/v2/alerts/destinations/{id}"],
		] as const) {
			expect(responseErrorTags(method, path, "401")).toContain(
				"@maple/http/errors/IntegrationsRevokedError",
			)
			expect(responseErrorTags(method, path, "409")).toContain(
				"@maple/http/errors/IntegrationsNotConnectedError",
			)
			expect(responseErrorTags(method, path, "502")).toContain(
				"@maple/http/errors/IntegrationsUpstreamError",
			)
		}
		expect(responseErrorTags("post", "/v2/alerts/destinations", "502")).not.toContain(
			"@maple/http/errors/AlertDeliveryError",
		)
	})

	it("declares exact alert-destination storage failures only where they can occur", () => {
		expect(responseErrorTags("post", "/v2/alerts/destinations", "500")).toContain(
			"@maple/http/errors/AlertDestinationEncryptionError",
		)
		for (const [method, path] of [
			["get", "/v2/alerts/destinations"],
			["get", "/v2/alerts/destinations/{id}"],
		] as const) {
			expect(responseErrorTags(method, path, "500")).toContain(
				"@maple/http/errors/AlertDestinationStoredConfigInvalidError",
			)
		}

		for (const [method, path] of [
			["patch", "/v2/alerts/destinations/{id}"],
			["post", "/v2/alerts/destinations/{id}/test"],
			["post", "/v2/alerts/rules/test"],
		] as const) {
			const tags = responseErrorTags(method, path, "500")
			expect(tags).toContain("@maple/http/errors/AlertDestinationDecryptionError")
			expect(tags).toContain("@maple/http/errors/AlertDestinationStoredConfigInvalidError")
		}

		for (const [method, path, tag] of [
			["post", "/v2/alerts/rules", "@maple/http/errors/AlertRuleStoredConfigInvalidError"],
			[
				"post",
				"/v2/alerts/destinations",
				"@maple/http/errors/AlertDestinationStoredConfigInvalidError",
			],
		] as const) {
			const tags = Object.keys(operation(method, path).responses)
				.filter((status) => Number(status) >= 400)
				.flatMap((status) => responseErrorTags(method, path, status))
			expect(tags, path).not.toContain(tag)
		}

		const previewTags = ["400", "401", "403", "404", "409", "429", "500", "502", "503", "504"]
			.filter((status) => operation("post", "/v2/alerts/rules/preview").responses[status] !== undefined)
			.flatMap((status) => responseErrorTags("post", "/v2/alerts/rules/preview", status))
		expect(previewTags).not.toContain("@maple/http/errors/AlertPersistenceError")
		expect(previewTags).not.toContain("@maple/http/errors/AlertDestinationDecryptionError")
		expect(previewTags).not.toContain("@maple/http/errors/AlertDestinationStoredConfigInvalidError")
		const destinationTestTags = ["400", "401", "403", "404", "409", "429", "500", "502", "503", "504"]
			.filter(
				(status) =>
					operation("post", "/v2/alerts/destinations/{id}/test").responses[status] !== undefined,
			)
			.flatMap((status) => responseErrorTags("post", "/v2/alerts/destinations/{id}/test", status))
		expect(destinationTestTags).not.toContain("@maple/http/errors/AlertValidationError")
	})

	it("distinguishes invalid email recipients from member-directory failures", () => {
		for (const [method, path] of [
			["post", "/v2/alerts/destinations"],
			["patch", "/v2/alerts/destinations/{id}"],
		] as const) {
			expect(responseErrorTags(method, path, "400")).toContain(
				"@maple/http/errors/AlertRecipientSelectionError",
			)
			expect(responseErrorTags(method, path, "500")).toContain(
				"@maple/http/errors/AlertMemberDirectoryNotConfiguredError",
			)
			expect(responseErrorTags(method, path, "503")).toContain(
				"@maple/http/errors/AlertMemberDirectoryUnavailableError",
			)
		}
	})

	it("decodes slack-bot destination create/update params and rejects a blank channel_id", () => {
		expect(schemas["AlertDestinationCreateSlackBot"], "create component present").toBeDefined()
		expect(schemas["AlertDestinationUpdateSlackBot"], "update component present").toBeDefined()

		const created = Schema.decodeUnknownSync(V2AlertDestinationCreateParams)({
			type: "slack-bot",
			name: "On-call Slack",
			channel_id: "C0789CHAN",
			channel_name: "incidents",
			enabled: true,
		})
		expect(created.type).toBe("slack-bot")

		// channel_name is optional on create.
		const minimal = Schema.decodeUnknownSync(V2AlertDestinationCreateParams)({
			type: "slack-bot",
			name: "On-call Slack",
			channel_id: "C0789CHAN",
			enabled: true,
		})
		expect(minimal.type).toBe("slack-bot")

		const updated = Schema.decodeUnknownSync(V2AlertDestinationUpdateParams)({
			type: "slack-bot",
			channel_name: "alerts",
		})
		expect(updated.type).toBe("slack-bot")

		// channel_id was tightened to a non-empty optional string — an explicit
		// blank must fail decoding instead of silently wiping the stored channel.
		expect(() =>
			Schema.decodeUnknownSync(V2AlertDestinationUpdateParams)({
				type: "slack-bot",
				channel_id: "",
			}),
		).toThrow()
	})

	it("decodes the internal slack-bot destination config schemas", () => {
		const config = Schema.decodeUnknownSync(SlackBotAlertDestinationConfig)({
			type: "slack-bot",
			name: "Slack bot",
			channelId: "C0789CHAN",
			channelName: "incidents",
			enabled: true,
		})
		expect(config.channelId).toBe("C0789CHAN")

		const update = Schema.decodeUnknownSync(UpdateSlackBotAlertDestinationConfig)({
			channelName: "alerts",
		})
		expect(update.channelName).toBe("alerts")

		// Same tightening as the v2 params: a blank channelId must fail decoding.
		expect(() =>
			Schema.decodeUnknownSync(UpdateSlackBotAlertDestinationConfig)({ channelId: "" }),
		).toThrow()
		expect(() =>
			Schema.decodeUnknownSync(SlackBotAlertDestinationConfig)({
				type: "slack-bot",
				name: "Slack bot",
				channelId: "",
			}),
		).toThrow()
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
		const parameters = decodeParameterNames(operation("get", "/v2/session_replays/{id}").parameters)
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

	/**
	 * `Schema.optional(X)` is `optionalKey(UndefinedOr(X))`, and Effect's
	 * JSON-Schema renderer emits `{type: "null"}` for the `Undefined` keyword just
	 * as it does for `Null`. Left alone, every optional query parameter published
	 * `anyOf: [X, {type: "null"}]` while the decoder rejected a present `null`.
	 * `collapseQueryParameterNullBranches` removes that branch — see
	 * `openapi-nullable.ts` for why the collapse stops at query parameters.
	 */
	describe("nullable-union rendering", () => {
		const queryParameters = (): ReadonlyArray<GeneratedOpenApiObject> =>
			Object.values(spec.paths as GeneratedOpenApiObject).flatMap((item) =>
				Object.entries(item as GeneratedOpenApiObject)
					.filter(([method]) => method !== "parameters")
					.flatMap(([, operation]) =>
						((operation as GeneratedOpenApiObject).parameters ?? []).filter(
							(parameter: GeneratedOpenApiObject) => parameter.in === "query",
						),
					),
			)

		const hasNullBranch = (schema: GeneratedOpenApiObject): boolean => {
			const resolved = resolveSchema(schema)
			const members = resolved.anyOf as ReadonlyArray<GeneratedOpenApiObject> | undefined
			return members?.some((member) => resolveSchema(member).type === "null") === true
		}

		it("publishes no query parameter that accepts null", () => {
			const parameters = queryParameters()
			expect(parameters.length).toBeGreaterThan(0)
			const nullable = parameters
				.filter((parameter) => hasNullBranch(parameter.schema as GeneratedOpenApiObject))
				.map((parameter) => parameter.name as string)
			expect(nullable).toEqual([])
		})

		/**
		 * The collapse is only sound while no query field is a real `Schema.NullOr`,
		 * which renders identically. This asserts it against the schema ASTs rather
		 * than the document, because the document cannot tell the two apart — that
		 * indistinguishability is exactly why the MCP-side blanket collapse could
		 * not be reused here.
		 */
		it("declares no genuinely nullable query field", () => {
			// SAFETY: `HttpApi` exposes no public reader for an endpoint's declared
			// schemas, so the walk is structural. Every read below is optional-chained
			// and the assertions are on the collected result, so a shape change in
			// Effect surfaces as an empty walk failing the paired parameter test above,
			// not as a throw here.
			const readGroups = (api: unknown): GeneratedOpenApiObject =>
				(api as GeneratedOpenApiObject).groups ?? {}
			const record = (value: unknown): GeneratedOpenApiObject => (value as GeneratedOpenApiObject) ?? {}

			const nullable: string[] = []
			for (const [groupName, group] of Object.entries(readGroups(MapleApiV2))) {
				for (const [endpointName, endpoint] of Object.entries(record(group).endpoints ?? {})) {
					const ast = record(endpoint).query?.ast
					for (const property of ast?.propertySignatures ?? []) {
						const type = record(property).type
						if (type?._tag !== "Union") continue
						if (type.types.some((member: GeneratedOpenApiObject) => member?._tag === "Null")) {
							nullable.push(`${groupName}.${endpointName}.${String(record(property).name)}`)
						}
					}
				}
			}
			expect(nullable).toEqual([])
		})

		it("keeps the parameter's own documentation when it drops the null branch", () => {
			const cursor = queryParameters().find((parameter) => parameter.name === "cursor")
			expect(cursor?.schema).toMatchObject({
				type: "string",
				title: "Cursor",
				examples: ["off_1k"],
			})
			expect(cursor?.required).toBe(false)
			expect(cursor?.schema.description).toContain("next_cursor")
		})

		/**
		 * The other half of the invariant: response and request-body fields declared
		 * `Schema.NullOr` really do carry `null`, so narrowing them the way the MCP
		 * registry narrows its tool inputs would publish a spec that rejects the
		 * server's own output.
		 */
		it("leaves genuinely nullable body and response fields alone", () => {
			for (const [schemaName, property] of [
				["ApiKey", "description"],
				["ApiKey", "revoked_at"],
				["ApiKey", "expires_at"],
				["ApiKeyList", "next_cursor"],
			] as const) {
				const field = (schemas[schemaName] as GeneratedOpenApiObject).properties[property]
				expect(hasNullBranch(field as GeneratedOpenApiObject), `${schemaName}.${property}`).toBe(true)
			}
		})

		it("carries no component left unreferenced by inlining a parameter schema", () => {
			const referenced = new Set<string>()
			const walk = (node: unknown): void => {
				if (Array.isArray(node)) return node.forEach(walk)
				if (node === null || typeof node !== "object") return
				const object = node as GeneratedOpenApiObject
				const ref = object.$ref as string | undefined
				if (ref !== undefined) {
					const name = ref.slice(ref.lastIndexOf("/") + 1)
					if (!referenced.has(name)) {
						referenced.add(name)
						walk(schemas[name])
					}
				}
				Object.values(object).forEach(walk)
			}
			walk(spec.paths)
			expect(Object.keys(schemas).filter((name) => !referenced.has(name))).toEqual([])
		})
	})

	it("documents every static error policy field as a literal", () => {
		const notFound = schemas["ApiKeyNotFoundError"]
		const properties = notFound.properties.error.properties
		expect(properties._tag.enum).toEqual(["@maple/http/errors/ApiKeyNotFoundError"])
		expect(properties.type.enum).toEqual(["not_found_error"])
		expect(properties.code.enum).toEqual(["api_key_not_found"])
		expect(properties.title.enum).toEqual(["API key not found"])
		expect(properties.message.enum).toEqual(["No such API key."])
		expect(properties.retryable.enum).toEqual([false])
		expect(properties.recovery.enum).toEqual(["none"])
	})
})
