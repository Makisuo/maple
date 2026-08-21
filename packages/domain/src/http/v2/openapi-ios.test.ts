import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { PublicHttpErrorBodySchema } from "../error-policy"

/**
 * Guards the pruned OpenAPI document that the native iOS app's Swift client is
 * generated from (`bun run ios:openapi`).
 *
 * The generator script exists because swift-openapi-generator produces hostile
 * Swift for Effect's union idioms — a struct-of-optionals instead of a plain
 * `String?` or `Double`. These assertions are what keep the normalization from
 * silently regressing: each one corresponds to a transform whose absence would
 * still produce a *compiling* client, just an unusable one.
 *
 * Drift between this file and the contract is caught separately by
 * `bun run ios:openapi:check` on CI's `quality` shard.
 */
const specPath = fileURLToPath(
	new URL("../../../../../apps/ios/Packages/MapleAPI/Sources/MapleAPI/openapi.json", import.meta.url),
)

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type, maple/no-record-string-any, typescript/no-explicit-any -- reading a generated JSON document structurally.
type JsonObject = Record<string, any>

// SAFETY: the file is written by `scripts/generate-ios-openapi.ts` as a JSON
// object; a parse failure or a non-object throws here and fails the suite, which
// is the intended signal.
const spec = JSON.parse(readFileSync(specPath, "utf8")) as JsonObject
const specText = JSON.stringify(spec)
const schemas = spec.components.schemas as JsonObject

/** Every operation the app calls. Must match `IOS_OPERATIONS` in the generator. */
const IOS_OPERATIONS = [
	"listServices",
	"getService",
	"queryTraceTimeseries",
	"queryTraceBreakdown",
	"listErrorIssues",
	"listErrorIssueServiceCounts",
	"getErrorIssue",
	"listAlertIncidents",
	"getAlertIncident",
	"listAlertRules",
	"getAlertRule",
	"listAlertRuleChecks",
	"listAlertDeliveries",
	"listAnomalyIncidents",
	"getAnomalyIncident",
	"getAnomalyIncidentTimeseries",
	"listMobileDevices",
	"registerMobileDevice",
	"unregisterMobileDevice",
	"registerLiveActivity",
	"endLiveActivity",
	"mintWidgetCredential",
	"revokeWidgetCredential",
	"getWidgetSummary",
] as const

/**
 * Unions that are *real* — discriminated request shapes, not Effect's
 * nullability/non-finite/constraint idioms. These generate a Swift enum with
 * one case per branch, which is the right thing. Anything else carrying an
 * `anyOf` is a normalization regression.
 */
const GENUINE_UNIONS = ["AttributeFilter"] as const

const operations = (): ReadonlyArray<JsonObject> =>
	Object.values(spec.paths as JsonObject).flatMap((item) =>
		Object.entries(item as JsonObject)
			.filter(([method]) => method !== "parameters")
			.map(([, operation]) => operation as JsonObject),
	)

describe("iOS OpenAPI spec", () => {
	it("exposes exactly the allowlisted operations", () => {
		const ids = operations()
			.map((operation) => operation.operationId as string)
			.sort()
		expect(ids).toEqual([...IOS_OPERATIONS].sort())
	})

	it("has no dangling $refs", () => {
		const refs = new Set<string>()
		const walk = (node: unknown): void => {
			if (Array.isArray(node)) return node.forEach(walk)
			if (node === null || typeof node !== "object") return
			const object = node as JsonObject
			if (typeof object.$ref === "string") refs.add(object.$ref)
			Object.values(object).forEach(walk)
		}
		walk(spec)

		const dangling = [...refs].filter((ref) => {
			const name = ref.replace("#/components/schemas/", "")
			return schemas[name] === undefined
		})
		expect(dangling).toEqual([])
	})

	it("carries no unreachable schemas", () => {
		const reachable = new Set<string>()
		const walk = (node: unknown): void => {
			if (Array.isArray(node)) return node.forEach(walk)
			if (node === null || typeof node !== "object") return
			const object = node as JsonObject
			if (typeof object.$ref === "string") {
				const name = object.$ref.replace("#/components/schemas/", "")
				if (!reachable.has(name)) {
					reachable.add(name)
					walk(schemas[name])
				}
			}
			Object.values(object).forEach(walk)
		}
		walk(spec.paths)

		expect(Object.keys(schemas).filter((name) => !reachable.has(name))).toEqual([])
	})

	/**
	 * Each of these would generate a `Union_N` struct-of-optionals in Swift:
	 * `notes` as `.value1: String?`, `error_rate` as a wrapper around a Double.
	 */
	it("collapses every synthetic union", () => {
		const withoutGenuine = JSON.stringify(
			Object.fromEntries(
				Object.entries(schemas).filter(([name]) => !GENUINE_UNIONS.includes(name as never)),
			),
		)
		expect(withoutGenuine).not.toContain('"anyOf"')
		expect(withoutGenuine).not.toContain('"allOf"')
		expect(JSON.stringify(spec.paths)).not.toContain('"anyOf"')
		expect(specText).not.toContain('"type":"null"')
		expect(Object.keys(schemas).filter((name) => name.startsWith("Union_"))).toEqual([])
	})

	it("emits one component per domain enum", () => {
		// `_maple_AlertSignalType_2` next to `_maple_AlertSignalType` would give
		// the app two unrelated Swift enums for the same wire values.
		const numbered = Object.keys(schemas).filter((name) => /^_maple_.+_\d+$/.test(name))
		expect(numbered).toEqual([])
	})

	it("keeps nullable fields optional and non-nullable fields required", () => {
		const issue = schemas.ErrorIssue as JsonObject
		const required = issue.required as ReadonlyArray<string>

		// `Schema.NullOr` — the key is always emitted, so Swift models it as Optional.
		for (const key of ["notes", "severity", "assigned_actor", "resolved_at"]) {
			expect(issue.properties[key]).toBeDefined()
			expect(required).not.toContain(key)
		}

		// A collapsed *number* union must not become optional along the way.
		expect(required).toContain("occurrence_count")
		expect(issue.properties.occurrence_count).toEqual({ type: "number" })
		expect((schemas.Service as JsonObject).required).toContain("error_rate")
		expect((schemas.Service as JsonObject).properties.error_rate).toEqual({ type: "number" })
	})

	it("merges widened enum query params into a single enum", () => {
		const parameters = (spec.paths["/v2/error_issues"] as JsonObject).get
			.parameters as ReadonlyArray<JsonObject>
		const severity = parameters.find((parameter) => parameter.name === "severity")
		expect(severity?.schema).toEqual({
			type: "string",
			enum: ["critical", "high", "medium", "low", "unset"],
		})
	})

	it("routes every error response through the single envelope", () => {
		for (const operation of operations()) {
			for (const [status, response] of Object.entries(operation.responses as JsonObject)) {
				if (/^2\d\d$/.test(status)) continue
				const schema = (response as JsonObject).content?.["application/json"]?.schema
				if (schema === undefined) continue
				expect(schema, `${operation.operationId} ${status}`).toEqual({
					$ref: "#/components/schemas/MapleErrorEnvelope",
				})
			}
		}
	})

	/**
	 * The envelope is hand-authored in the generator rather than derived, so a new
	 * field on the real error body would otherwise never reach the iOS client.
	 */
	it("declares every field the runtime error envelope can emit", () => {
		const runtimeFields = Object.keys(PublicHttpErrorBodySchema.fields)
		const declared = Object.keys((schemas.MapleErrorEnvelope as JsonObject).properties.error.properties)
		expect(declared.sort()).toEqual(runtimeFields.sort())
	})

	it("keeps timestamps as plain strings", () => {
		// A `format: date-time` would make swift-openapi-generator emit `Foundation.Date`,
		// which cannot parse the fractional-seconds form the API returns.
		const issue = schemas.ErrorIssue as JsonObject
		for (const key of ["first_seen_at", "last_seen_at"]) {
			expect(issue.properties[key]).toEqual({ type: "string" })
		}
	})

	it("declares production as the only server and bearer as the only scheme", () => {
		expect(spec.servers).toEqual([{ url: "https://api.maple.dev", description: "Production" }])
		expect(Object.keys(spec.components.securitySchemes)).toEqual(["bearer"])
		for (const operation of operations()) {
			expect(operation.security, operation.operationId as string).toEqual([{ bearer: [] }])
		}
	})
})
