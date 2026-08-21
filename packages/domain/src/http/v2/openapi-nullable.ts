/**
 * Removes the phantom `null` branch that Effect's JSON-Schema renderer emits for
 * `Schema.optional` query parameters.
 *
 * `Schema.optional(X)` is `optionalKey(UndefinedOr(X))`, and the renderer maps
 * both the `Undefined` and the `Null` AST keyword to `{ "type": "null" }`. So a
 * parameter declared `Schema.optional(Schema.String)` publishes
 * `anyOf: [{type: "string"}, {type: "null"}]` while the decoder rejects a
 * present `null` with `Expected string | undefined`. Every v2 list endpoint's
 * `limit`/`cursor` and every filter param carried that lie to `/v2/docs`.
 *
 * **Why this is scoped to query parameters, and must stay scoped.**
 *
 * `Schema.NullOr(X)` renders byte-identically — and unlike the MCP tool surface,
 * the public API is full of genuinely nullable fields: 649 rendered positions
 * (83 in request bodies, 566 in responses) really do accept and emit `null`.
 * Collapsing those would publish a spec that rejects the server's own output.
 * The MCP fix (`collapseNullableUnions` in `apps/api/src/mcp/tools/registry.ts`)
 * could collapse a whole document only because no MCP parameter was nullable;
 * transplanting it here would be wrong at 88% of the sites it touched.
 *
 * Query parameters are the one region where the collapse is unconditionally
 * safe: no v2 query field is nullable, and a query string cannot carry a JSON
 * `null` to begin with. `openapi.test.ts` pins that invariant against the
 * schema ASTs, so a future `Schema.NullOr` query param fails CI rather than
 * being silently narrowed here.
 *
 * The collapsed schema is written **inline** at the parameter rather than into
 * the hoisted component it came from (`Union_1`, the shared `cursor`). Inlining
 * is what makes the pass safe by construction — a component shared with a body
 * or response schema is never touched — and it keeps the synthetic `Union_N`
 * wrappers out of the parameter surface, which is what the iOS generator
 * (`scripts/generate-ios-openapi.ts`) and its `Union_`-free assertion expect.
 */

const HTTP_OPERATION_METHODS = ["get", "post", "put", "patch", "delete", "head"] as const

/**
 * The document is walked structurally, so it is modelled as plain JSON rather
 * than Effect's `OpenAPISpec` type (which prunes the generated fields this pass
 * reads). Narrowing at every read is the point — see the `as*` helpers.
 */
// The array member is mutable so `Array.isArray` narrows it out of the union in
// `asObject` — the guard is typed `arg is Array<any>` and leaves a
// `ReadonlyArray` branch behind, which would otherwise force a cast.
type JsonValue = string | number | boolean | null | Array<JsonValue> | JsonObject
interface JsonObject {
	[key: string]: JsonValue | undefined
}

const asObject = (value: JsonValue | undefined): JsonObject | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined

const asArray = (value: JsonValue | undefined): ReadonlyArray<JsonValue> | undefined =>
	Array.isArray(value) ? value : undefined

const asString = (value: JsonValue | undefined): string | undefined =>
	typeof value === "string" ? value : undefined

const COMPONENT_PREFIX = "#/components/schemas/"

const componentName = (ref: JsonValue | undefined): string | undefined => {
	const value = asString(ref)
	return value?.startsWith(COMPONENT_PREFIX) === true ? value.slice(COMPONENT_PREFIX.length) : undefined
}

/**
 * `anyOf: [T, {type: "null"}]` → `T`, keeping the sibling keys that hang off the
 * union itself. Siblings are applied last, so a `description` written on the
 * property outranks one written on the surviving branch.
 */
const withoutNullBranch = (schema: JsonObject): JsonObject | undefined => {
	const members = asArray(schema.anyOf)
	if (members === undefined || members.length !== 2) return undefined

	const nullIndex = members.findIndex((member) => asObject(member)?.type === "null")
	if (nullIndex === -1) return undefined

	const kept = asObject(members[1 - nullIndex])
	if (kept === undefined) return undefined

	const { anyOf: _removed, ...siblings } = schema
	return { ...kept, ...siblings }
}

/** Every component name reachable from `node`, following `$ref` transitively. */
const collectRefs = (node: JsonValue | undefined, schemas: JsonObject, into: Set<string>): void => {
	const entries = asArray(node)
	if (entries !== undefined) {
		for (const entry of entries) collectRefs(entry, schemas, into)
		return
	}
	const object = asObject(node)
	if (object === undefined) return

	const name = componentName(object.$ref)
	if (name !== undefined && !into.has(name)) {
		into.add(name)
		collectRefs(schemas[name], schemas, into)
	}
	for (const value of Object.values(object)) collectRefs(value, schemas, into)
}

/**
 * Collapse the phantom `null` branch on every query parameter of every operation.
 *
 * Mutates and returns `spec` — it runs inside `OpenApi.annotations({ transform })`,
 * which already hands over a private clone of the generated document.
 */
export const collapseQueryParameterNullBranches = <S>(spec: S): S => {
	const document = asObject(spec as JsonValue)
	if (document === undefined) return spec

	const schemas = asObject(asObject(document.components)?.schemas) ?? {}
	const paths = asObject(document.paths) ?? {}
	const inlinedAway = new Set<string>()

	for (const rawItem of Object.values(paths)) {
		const item = asObject(rawItem)
		if (item === undefined) continue

		for (const method of HTTP_OPERATION_METHODS) {
			const operation = asObject(item[method])
			if (operation === undefined) continue

			for (const rawParameter of asArray(operation.parameters) ?? []) {
				const parameter = asObject(rawParameter)
				if (parameter === undefined || parameter.in !== "query") continue

				const schema = asObject(parameter.schema)
				if (schema === undefined) continue

				// The renderer hoists most parameter schemas into a `Union_N`
				// component, so resolve one level of `$ref` before looking for the
				// null branch. The component itself is left alone; only the
				// parameter's own schema is replaced.
				const hoisted = componentName(schema.$ref)
				const target = hoisted === undefined ? schema : asObject(schemas[hoisted])
				if (target === undefined) continue

				const collapsed = withoutNullBranch(target)
				if (collapsed === undefined) continue

				parameter.schema = collapsed
				if (hoisted !== undefined) inlinedAway.add(hoisted)
			}
		}
	}

	// A component that existed only to wrap a parameter's null branch is now
	// unreferenced; leaving it behind would publish dead `Union_N` schemas.
	if (inlinedAway.size > 0) {
		const reachable = new Set<string>()
		collectRefs(document.paths, schemas, reachable)
		for (const name of inlinedAway) {
			if (!reachable.has(name)) delete schemas[name]
		}
	}

	return spec
}
