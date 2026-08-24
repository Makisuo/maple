/**
 * Generates the pruned, normalized OpenAPI document that the native iOS app's
 * Swift client is generated from (`apps/ios/Packages/MapleAPI`).
 *
 * The full v2 document is ~94 paths / 129 operations / 480+ schemas. Feeding
 * that to swift-openapi-generator produces six figures of Swift and a build
 * that never settles, so this script prunes it to the operations the app
 * actually calls and normalizes two Effect-isms that generate hostile Swift:
 *
 *  1. Nullability is emitted as `anyOf: [S, { type: "null" }]`, often behind an
 *     anonymous `Union_N` component. Left alone, `notes` becomes `Union_23`
 *     with a `.value1: String?` instead of `String?`. We rewrite those to `S`
 *     and drop the key from `required` — lossless, because the generator emits
 *     `decodeIfPresent`, which yields `nil` for both an explicit `null` and an
 *     absent key, and `Schema.NullOr` always emits the key.
 *  1b. Every `Schema.Number` is emitted as
 *     `anyOf: [{ type: "number" }, enum["Infinity", "-Infinity", "NaN"]]`,
 *     because Effect encodes non-finite doubles as those strings. That union
 *     is attached to *every* numeric field, so left alone each metric on
 *     `Service` becomes a struct-of-optionals. We collapse it to `number`.
 *     See `NON_FINITE_NUMBER_ENUM` for why that is the right trade.
 *  2. Error responses are per-status `anyOf` unions over literal-`_tag`
 *     branches — over half the reachable schemas. They are all structurally the
 *     same envelope, so they collapse to one `MapleErrorEnvelope` whose `_tag`
 *     is a plain string. That is how the server intends it to be consumed:
 *     `public-error.ts` documents `_tag` as "Stable semantic error tag. Branch
 *     on this exact value."
 *
 * The output is committed so the iOS CI job stays hermetic (no bun on a macOS
 * runner); drift is caught by `--check` on the cheap Linux `quality` shard.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { OpenApi } from "effect/unstable/httpapi"
import { MapleApiV2 } from "../packages/domain/src/http/v2/api"

/**
 * The operations the iOS app calls. Adding a screen means adding an id here and
 * re-running the script — the incremental cost of the allowlist is two lines.
 */
const IOS_OPERATIONS: ReadonlyArray<string> = [
	// Services
	"listServices",
	"listEnvironments",
	"getService",
	"queryTraceTimeseries",
	"queryTraceBreakdown",
	// Errors
	"listErrorIssues",
	"listErrorIssueServiceCounts",
	"getErrorIssue",
	// Alerts
	"listAlertIncidents",
	"getAlertIncident",
	"listAlertRules",
	"getAlertRule",
	"listAlertRuleChecks",
	"listAlertDeliveries",
	// Anomalies
	"listAnomalyIncidents",
	"getAnomalyIncident",
	"getAnomalyIncidentTimeseries",
	// Push
	"listMobileDevices",
	"registerMobileDevice",
	"unregisterMobileDevice",
	"registerLiveActivity",
	"endLiveActivity",
	"mintWidgetCredential",
	"revokeWidgetCredential",
	// Home Screen widgets — one read, and the only one a device credential reaches.
	"getWidgetSummary",
]

const ERROR_ENVELOPE_SCHEMA_NAME = "MapleErrorEnvelope"

/** The three strings Effect encodes non-finite doubles as. */
const NON_FINITE_NUMBER_ENUM = ["Infinity", "-Infinity", "NaN"] as const

const outputPath = fileURLToPath(
	new URL("../apps/ios/Packages/MapleAPI/Sources/MapleAPI/openapi.json", import.meta.url),
)
const checkMode = process.argv.includes("--check")

/**
 * The document is rewritten structurally, so it is modelled as plain JSON rather
 * than as Effect's `OpenAPISpec` type (which omits the generated extension
 * fields this script reads). Narrowing at every read is the point — see the
 * `as*` helpers below.
 */
type JsonValue = string | number | boolean | null | ReadonlyArray<JsonValue> | JsonObject
interface JsonObject {
	[key: string]: JsonValue | undefined
}

const asObject = (value: JsonValue | undefined): JsonObject | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined

const asArray = (value: JsonValue | undefined): ReadonlyArray<JsonValue> | undefined =>
	Array.isArray(value) ? value : undefined

/** An array whose entries are all objects — the shape `anyOf`/`allOf`/`parameters` take. */
const asObjectArray = (value: JsonValue | undefined): ReadonlyArray<JsonObject> | undefined => {
	const entries = asArray(value)
	if (entries === undefined) return undefined
	const objects = entries.map(asObject)
	return objects.every((entry) => entry !== undefined) ? (objects as ReadonlyArray<JsonObject>) : undefined
}

const asString = (value: JsonValue | undefined): string | undefined =>
	typeof value === "string" ? value : undefined

const asStringArray = (value: JsonValue | undefined): ReadonlyArray<string> | undefined => {
	const entries = asArray(value)
	if (entries === undefined) return undefined
	return entries.every((entry) => typeof entry === "string")
		? (entries as ReadonlyArray<string>)
		: undefined
}

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const

const { text: rendered, doc: renderedDoc } = render()

let existing = ""
try {
	existing = readFileSync(outputPath, "utf8")
} catch {
	existing = ""
}

if (checkMode) {
	if (existing !== rendered) {
		console.error("iOS OpenAPI spec is out of date. Run `bun run ios:openapi`.")
		process.exit(1)
	}
	const { pathCount, schemaCount } = summarize(renderedDoc)
	console.log(`iOS OpenAPI spec is up to date (${pathCount} paths, ${schemaCount} schemas).`)
} else {
	writeFileSync(outputPath, rendered)
	const { pathCount, schemaCount } = summarize(renderedDoc)
	console.log(
		`Wrote iOS OpenAPI spec (${pathCount} paths, ${schemaCount} schemas, ${byteSize(rendered)}) to ${outputPath}.`,
	)
}

function render(): { text: string; doc: JsonObject } {
	// SAFETY: `OpenApi.fromApi` returns a JSON-serializable OpenAPI document, so
	// its structuredClone is by construction a JSON object.
	const doc = structuredClone(OpenApi.fromApi(MapleApiV2)) as unknown as JsonObject

	prunePaths(doc)
	collapseNullableUnions(doc)
	collapseErrorResponses(doc)
	mergeDuplicateEnums(doc)
	sweepUnreachableSchemas(doc)

	const sorted = sortKeysDeep(doc)
	return { text: `${JSON.stringify(sorted, null, 2)}\n`, doc: asObject(sorted) ?? {} }
}

/**
 * Pass 1 — keep only the allowlisted operations.
 *
 * A missing id is fatal: a server-side rename must break the generator loudly
 * rather than silently shrink the client and surface days later as a confusing
 * "no such method" in Xcode.
 */
function prunePaths(doc: JsonObject): void {
	const paths = asObject(doc.paths) ?? {}
	const found = new Set<string>()

	for (const [path, rawItem] of Object.entries(paths)) {
		const item = asObject(rawItem)
		if (item === undefined) continue

		for (const method of HTTP_METHODS) {
			const operation = asObject(item[method])
			if (operation === undefined) continue

			const operationId = asString(operation.operationId)
			if (operationId !== undefined && IOS_OPERATIONS.includes(operationId)) {
				found.add(operationId)
			} else {
				delete item[method]
			}
		}

		if (HTTP_METHODS.every((method) => item[method] === undefined)) {
			delete paths[path]
		}
	}

	const missing = IOS_OPERATIONS.filter((id) => !found.has(id))
	if (missing.length > 0) {
		console.error(
			`These operations are in IOS_OPERATIONS but not in the v2 contract: ${missing.join(", ")}.\n` +
				"They were probably renamed. Update IOS_OPERATIONS in scripts/generate-ios-openapi.ts.",
		)
		process.exit(1)
	}
}

/**
 * Pass 2 — rewrite `anyOf: [S, { type: "null" }]` to `S`, and mark the owning
 * property/parameter optional so the generator emits `decodeIfPresent`.
 * Also collapses Effect's non-finite-number union (see `NON_FINITE_NUMBER_ENUM`).
 */
function collapseNullableUnions(doc: JsonObject): void {
	const schemas = asObject(asObject(doc.components)?.schemas) ?? {}

	// Snapshot before any deletion: collapsing `Union_12` needs to look through
	// its `$ref` to `Union_11`, which is itself removed along the way.
	const originalSchemas: JsonObject = { ...schemas }
	const deref = (schema: JsonObject): JsonObject => {
		const ref = asString(schema.$ref)
		const name = ref === undefined ? undefined : componentNameFromRef(ref)
		if (name === undefined) return schema
		return asObject(originalSchemas[name]) ?? schema
	}
	/**
	 * Collapse one synthetic union. `nullable` says whether the *container* has
	 * to make the key optional: dropping a `null` branch moves that information
	 * onto the key, whereas dropping the non-finite-number branch does not.
	 */
	/**
	 * Peel synthetic unions until nothing changes. They nest: an optional
	 * widened enum arrives as `anyOf[anyOf[Severity, "unset"], null]`, so one
	 * pass would leave the inner union — and a struct-of-optionals — behind.
	 */
	const collapse = (schema: JsonObject): Collapsed | undefined => {
		let current = schema
		let nullable = false
		let collapsed = false

		for (let pass = 0; pass < 8; pass++) {
			const withoutNull = nullableInnerSchema(current)
			if (withoutNull !== undefined) {
				current = withoutNull
				nullable = true
				collapsed = true
				continue
			}
			const next =
				finiteNumberSchema(current, deref) ??
				mergedStringEnum(current, deref) ??
				flattenedConstraintAllOf(current) ??
				singleBranchUnion(current)
			if (next === undefined) break
			current = next
			collapsed = true
		}

		return collapsed ? { schema: current, nullable } : undefined
	}

	// Named components that are nothing but a synthetic wrapper collapse into
	// whatever they wrap, and every $ref to them is redirected. Iterate to a
	// fixed point: `Union_12` wraps a number union that references `Union_11`.
	const aliases = new Map<string, Collapsed>()
	for (let pass = 0; pass < 8; pass++) {
		let changed = false
		for (const [name, rawSchema] of Object.entries(schemas)) {
			if (aliases.has(name)) continue
			const schema = asObject(rawSchema)
			if (schema === undefined) continue
			const collapsed = collapse(schema)
			if (collapsed !== undefined) {
				aliases.set(name, collapsed)
				changed = true
			}
		}
		if (!changed) break
	}
	for (const name of aliases.keys()) delete schemas[name]

	/**
	 * Follow `$ref`s through collapsed aliases and peel unions, accumulating
	 * nullability.
	 *
	 * The two alternate rather than running once each: peeling
	 * `anyOf[$ref UserId, null]` yields a `$ref` that itself points at a
	 * collapsed alias, and stopping there would leave a dangling reference.
	 */
	const resolve = (schema: JsonObject): Collapsed => {
		let current = schema
		let nullable = false
		const seen = new Set<string>()

		for (let pass = 0; pass < 16; pass++) {
			const ref = asString(current.$ref)
			if (ref !== undefined) {
				const name = componentNameFromRef(ref)
				const alias = name === undefined ? undefined : aliases.get(name)
				if (name === undefined || alias === undefined || seen.has(name)) break
				seen.add(name)
				current = alias.schema
				nullable = nullable || alias.nullable
				continue
			}

			const collapsed = collapse(current)
			if (collapsed === undefined) break
			current = collapsed.schema
			nullable = nullable || collapsed.nullable
		}

		return { schema: current, nullable }
	}

	const visit = (node: JsonValue | undefined): JsonValue | undefined => {
		if (Array.isArray(node)) return node.map(visit) as ReadonlyArray<JsonValue>
		const object = asObject(node)
		if (object === undefined) return node

		const properties = asObject(object.properties)
		if (properties !== undefined) {
			const required = new Set<string>(asStringArray(object.required) ?? [])
			for (const [key, value] of Object.entries(properties)) {
				const target = asObject(value)
				if (target === undefined) continue
				const { schema, nullable } = resolve(target)
				// Descend as well: a property that is itself an array or object
				// can carry a union in its `items` (`AlertRule.group_by`).
				properties[key] = visit(schema)
				if (nullable) required.delete(key)
			}
			if (required.size > 0) object.required = [...required]
			else delete object.required
		}

		for (const parameter of asObjectArray(object.parameters) ?? []) {
			const target = asObject(parameter.schema)
			if (target === undefined) continue
			const { schema, nullable } = resolve(target)
			parameter.schema = schema
			if (nullable) parameter.required = false
		}

		for (const [key, value] of Object.entries(object)) {
			if (key === "properties" || key === "parameters" || key === "required") continue
			object[key] = visit(value)
		}

		// Reached anywhere else (array items, additionalProperties), a union still
		// collapses — optionality is then carried by the element type itself.
		return resolve(object).schema
	}

	visit(doc)
}

type Collapsed = { schema: JsonObject; nullable: boolean }

/**
 * `{ anyOf: [S, { type: "null" }] }` → `S`, in either branch order.
 * Returns undefined for anything that is not exactly that shape.
 */
function nullableInnerSchema(schema: JsonObject): JsonObject | undefined {
	const branches = asObjectArray(schema.anyOf)
	if (branches === undefined || branches.length !== 2) return undefined

	const nullIndex = branches.findIndex((branch) => branch.type === "null")
	if (nullIndex === -1) return undefined

	const inner = branches[nullIndex === 0 ? 1 : 0]
	if (inner === undefined || inner.type === "null") return undefined

	return mergeAnnotations(schema, inner)
}

/**
 * `{ anyOf: [{ type: "number" }, enum["Infinity", "-Infinity", "NaN"]] }` →
 * `{ type: "number" }`.
 *
 * Effect attaches this union to every `Schema.Number`, so without it each of
 * `Service`'s eleven metrics decodes into a struct-of-optionals rather than a
 * `Double`. The trade: if the warehouse ever returns a non-finite aggregate,
 * the response fails to decode and the screen shows its error state instead of
 * silently rendering a bogus number. That is the right failure — a non-finite
 * `error_rate` is a server bug — and it is loud enough to notice.
 */
function finiteNumberSchema(
	schema: JsonObject,
	deref: (schema: JsonObject) => JsonObject,
): JsonObject | undefined {
	const branches = asObjectArray(schema.anyOf)
	if (branches === undefined || branches.length !== 2) return undefined

	const isNonFiniteEnum = (branch: JsonObject): boolean => {
		const values = asStringArray(deref(branch).enum)
		return (
			values !== undefined &&
			values.length === NON_FINITE_NUMBER_ENUM.length &&
			NON_FINITE_NUMBER_ENUM.every((value) => values.includes(value))
		)
	}

	const enumIndex = branches.findIndex(isNonFiniteEnum)
	if (enumIndex === -1) return undefined

	const numeric = deref(branches[enumIndex === 0 ? 1 : 0] as JsonObject)
	if (numeric.type !== "number" && numeric.type !== "integer") return undefined

	return mergeAnnotations(schema, numeric)
}

/**
 * `{ anyOf: [enumA, enumB] }` where both branches are string enums → one enum
 * over the union of their values.
 *
 * The v2 contract widens an enum this way when a query param accepts an extra
 * sentinel — `severity` on `listErrorIssues` is `IssueSeverity | "unset"`.
 * Generated as a union it becomes a struct-of-optionals; merged it becomes the
 * single Swift enum the parameter actually is.
 */
function mergedStringEnum(
	schema: JsonObject,
	deref: (schema: JsonObject) => JsonObject,
): JsonObject | undefined {
	const branches = asObjectArray(schema.anyOf)
	if (branches === undefined || branches.length < 2) return undefined

	const values: Array<string> = []
	for (const branch of branches) {
		const resolved = deref(branch)
		const branchValues = asStringArray(resolved.enum)
		if (resolved.type !== "string" || branchValues === undefined) return undefined
		for (const value of branchValues) if (!values.includes(value)) values.push(value)
	}

	return mergeAnnotations(schema, { type: "string", enum: values })
}

/**
 * `{ type: "string", allOf: [{ minLength: 1 }, { pattern: … }] }` → one flat
 * string schema carrying those keywords directly.
 *
 * Effect emits a branded string's checks as `allOf` fragments beside the type.
 * swift-openapi-generator has no notion of intersecting constraints, so it
 * models `allOf` structurally — `_maple_TraceId` becomes a struct with
 * `value1` and `value2` rather than a `String`. Flattening loses nothing: the
 * generator does not enforce `minLength`/`pattern` either way, and the server
 * is the thing that validates.
 *
 * Only applied when every fragment is constraint- or annotation-only, so a real
 * composition (`allOf` over `$ref`s or `properties`) is left alone.
 */
function flattenedConstraintAllOf(schema: JsonObject): JsonObject | undefined {
	const fragments = asObjectArray(schema.allOf)
	if (fragments === undefined || fragments.length === 0) return undefined

	const structural = ["$ref", "properties", "items", "allOf", "anyOf", "oneOf", "additionalProperties"]
	const merged: JsonObject = {}

	for (const fragment of fragments) {
		if (structural.some((key) => fragment[key] !== undefined)) return undefined
		// A fragment may restate the parent's type, but must not contradict it.
		if (fragment.type !== undefined && fragment.type !== schema.type) return undefined
		Object.assign(merged, fragment)
	}

	const { allOf: _dropped, ...siblings } = schema
	return { ...merged, ...siblings }
}

/**
 * `{ anyOf: [S] }` → `S`. A one-member `Schema.Literals` (a platform enum with
 * one platform so far) is emitted as a single-branch union, which the
 * generator turns into a one-case enum wrapper around a one-case enum.
 */
function singleBranchUnion(schema: JsonObject): JsonObject | undefined {
	const branches = asObjectArray(schema.anyOf)
	if (branches === undefined || branches.length !== 1) return undefined
	return mergeAnnotations(schema, branches[0]!)
}

/** Fold a wrapper's sibling annotations (title, description) onto its inner schema. */
function mergeAnnotations(wrapper: JsonObject, inner: JsonObject): JsonObject {
	const { anyOf: _dropped, ...siblings } = wrapper
	return { ...siblings, ...inner }
}

/**
 * Pass 3 — every non-2xx response body becomes one `MapleErrorEnvelope`.
 *
 * The per-operation `anyOf` over literal-`_tag` branches accounts for over half
 * the reachable schemas and buys nothing: the app branches on `_tag`/`recovery`
 * as strings, exactly as the server documents.
 */
function collapseErrorResponses(doc: JsonObject): void {
	const schemas = asObject(asObject(doc.components)?.schemas) ?? {}
	schemas[ERROR_ENVELOPE_SCHEMA_NAME] = errorEnvelopeSchema()

	for (const rawItem of Object.values(asObject(doc.paths) ?? {})) {
		const item = asObject(rawItem)
		if (item === undefined) continue

		for (const method of HTTP_METHODS) {
			const responses = asObject(asObject(item[method])?.responses)
			if (responses === undefined) continue

			for (const [status, response] of Object.entries(responses)) {
				if (/^2\d\d$/.test(status)) continue
				const content = asObject(asObject(response)?.content)
				if (content?.["application/json"] === undefined) continue
				content["application/json"] = {
					schema: { $ref: `#/components/schemas/${ERROR_ENVELOPE_SCHEMA_NAME}` },
				}
			}
		}
	}
}

/**
 * Mirrors the runtime envelope from `packages/domain/src/http/v2/public-error.ts`.
 * `openapi-ios.test.ts` asserts this stays a superset of the real one.
 */
function errorEnvelopeSchema(): JsonObject {
	const string = (description: string) => ({ type: "string", description })
	return {
		type: "object",
		title: "Error",
		description: "Every Maple API failure returns this envelope. Branch on `error._tag`.",
		required: ["error"],
		additionalProperties: false,
		properties: {
			error: {
				type: "object",
				required: ["_tag", "type", "code", "title", "message", "retryable", "recovery"],
				additionalProperties: false,
				properties: {
					_tag: string("Stable semantic error tag. Branch on this exact value."),
					type: string("Coarse error class, e.g. `authentication_error`."),
					code: string("Stable public integration key, e.g. `invalid_credentials`."),
					title: string("Short human-readable summary, safe to show in UI."),
					message: string("Human-readable detail, safe to show in UI."),
					retryable: {
						type: "boolean",
						description: "Whether retrying the same request may succeed.",
					},
					recovery: string("Suggested recovery action, e.g. `reauthenticate` or `retry`."),
					retry_after_seconds: {
						type: "number",
						description: "Seconds to wait before retrying, when the server suggests one.",
					},
					retry_at: string("Absolute time after which a retry is permitted."),
					param: string("The request parameter at fault, for validation failures."),
				},
			},
		},
	}
}

/** Pass 4a — drop components no longer reachable from the pruned paths. */
/**
 * Pass 3b — one Swift enum per domain enum.
 *
 * Effect registers a component per *annotation site*, so a domain enum such as
 * `AlertSignalType` that is re-annotated on the incident, the check, and the
 * rule arrives as `_maple_AlertSignalType`, `_maple_AlertSignalType_2`,
 * `_maple_AlertSignalType_3` — identical `enum` + `type`, differing only in
 * `description`/`examples`. Left alone, the generator emits three unrelated
 * Swift enums and every comparison across them needs a raw-value round trip.
 * When the numbered copy is the same string enum as its base, point every
 * `$ref` at the base and drop the copy.
 */
function mergeDuplicateEnums(doc: JsonObject): void {
	const schemas = asObject(asObject(doc.components)?.schemas) ?? {}
	const aliases = new Map<string, string>()

	for (const name of Object.keys(schemas)) {
		const match = /^(.+)_(\d+)$/.exec(name)
		if (match === null) continue
		const base = match[1]
		const baseSchema = asObject(schemas[base])
		const copy = asObject(schemas[name])
		if (baseSchema === undefined || copy === undefined) continue
		const baseEnum = asStringArray(baseSchema.enum)
		const copyEnum = asStringArray(copy.enum)
		if (baseEnum === undefined || copyEnum === undefined) continue
		if (baseSchema.type !== "string" || copy.type !== "string") continue
		if (baseEnum.length !== copyEnum.length || baseEnum.some((value, index) => value !== copyEnum[index]))
			continue
		aliases.set(name, base)
	}

	const rewrite = (node: JsonValue | undefined): void => {
		if (Array.isArray(node)) {
			for (const entry of node) rewrite(entry)
			return
		}
		const object = asObject(node)
		if (object === undefined) return
		const ref = asString(object.$ref)
		if (ref !== undefined) {
			const name = componentNameFromRef(ref)
			const target = name === undefined ? undefined : aliases.get(name)
			if (target !== undefined) object.$ref = `#/components/schemas/${target}`
		}
		for (const value of Object.values(object)) rewrite(value)
	}

	rewrite(doc)
	for (const name of aliases.keys()) delete schemas[name]
}

function sweepUnreachableSchemas(doc: JsonObject): void {
	const schemas = asObject(asObject(doc.components)?.schemas) ?? {}
	const reachable = new Set<string>()

	const walk = (node: JsonValue | undefined): void => {
		if (Array.isArray(node)) {
			for (const entry of node) walk(entry)
			return
		}
		const object = asObject(node)
		if (object === undefined) return

		const ref = asString(object.$ref)
		if (ref !== undefined) {
			const name = componentNameFromRef(ref)
			if (name !== undefined && !reachable.has(name)) {
				reachable.add(name)
				walk(schemas[name])
			}
		}
		for (const value of Object.values(object)) walk(value)
	}

	walk(doc.paths)

	for (const name of Object.keys(schemas)) {
		if (!reachable.has(name)) delete schemas[name]
	}

	const dangling = [...reachable].filter((name) => schemas[name] === undefined)
	if (dangling.length > 0) {
		console.error(`Pruned spec has dangling $refs: ${dangling.join(", ")}.`)
		process.exit(1)
	}
}

function componentNameFromRef(ref: string): string | undefined {
	const prefix = "#/components/schemas/"
	return ref.startsWith(prefix) ? ref.slice(prefix.length) : undefined
}

/** Pass 4b — deterministic key order, so `--check` is byte-stable. */
function sortKeysDeep(node: JsonValue | undefined): JsonValue | undefined {
	if (Array.isArray(node)) return node.map(sortKeysDeep) as ReadonlyArray<JsonValue>
	const object = asObject(node)
	if (object === undefined) return node

	const sorted: JsonObject = {}
	for (const key of Object.keys(object).sort()) sorted[key] = sortKeysDeep(object[key])
	return sorted
}

function summarize(doc: JsonObject): { pathCount: number; schemaCount: number } {
	return {
		pathCount: Object.keys(asObject(doc.paths) ?? {}).length,
		schemaCount: Object.keys(asObject(asObject(doc.components)?.schemas) ?? {}).length,
	}
}

function byteSize(text: string): string {
	return `${Math.round(Buffer.byteLength(text, "utf8") / 1024)} KB`
}
