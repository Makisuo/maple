import * as v from "valibot"

/**
 * Convert a JSON Schema document into a Valibot schema.
 *
 * Flue's `defineTool` requires `input` to be a real Valibot object schema — it
 * checks the `~standard.vendor` marker and then derives the model-facing JSON
 * Schema back out of it with `@valibot/to-json-schema`. Maple's tools, however,
 * describe themselves in JSON Schema: `apps/api`'s registry runs each tool's
 * Effect Schema through `Schema.toJsonSchemaDocument` and ships the result over
 * the `MAPLE_API_RPC` binding as `InternalMcpToolDescriptor.inputSchema`. This
 * bridges the two so the model still sees the tool's real parameters instead of
 * an opaque record.
 *
 * The supported subset is the one Effect emits for the tool registry: objects,
 * strings (incl. `enum`), numbers, integers, booleans, arrays, `anyOf`/`oneOf`
 * unions, `const`, and `$ref` into `$defs`. Anything outside it degrades to
 * `v.unknown()` rather than throwing — a tool with one exotic parameter should
 * lose that parameter's typing, not vanish from the agent's toolset.
 */

type JsonSchema = Record<string, unknown>

/** `$defs` (and legacy `definitions`) hoisted once so `$ref` resolution is a lookup. */
type Defs = Record<string, JsonSchema>

const isObject = (value: unknown): value is JsonSchema =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const asSchema = (value: unknown): JsonSchema | undefined => (isObject(value) ? value : undefined)

const describe = <S extends v.GenericSchema>(schema: S, node: JsonSchema): v.GenericSchema => {
	const description = typeof node.description === "string" ? node.description.trim() : ""
	return description.length > 0 ? v.pipe(schema, v.description(description)) : schema
}

/** Resolve a local `#/$defs/Name` pointer. Remote and nested pointers are unsupported. */
const resolveRef = (ref: string, defs: Defs): JsonSchema | undefined => {
	const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref)
	if (!match) return undefined
	return defs[decodeURIComponent(match[1]!)]
}

const literal = (value: unknown): v.GenericSchema => {
	if (value === null) return v.null()
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return v.literal(value)
	}
	return v.unknown()
}

/** Narrow a JSON Schema `type` that may be a string or an array of strings. */
const primaryType = (node: JsonSchema): string | undefined => {
	const type = node.type
	if (typeof type === "string") return type
	if (Array.isArray(type)) {
		// `["string", "null"]` is how nullable fields arrive; the union arm below
		// re-adds the null, so pick the first non-null member as the base type.
		const named = type.find((entry) => typeof entry === "string" && entry !== "null")
		return typeof named === "string" ? named : undefined
	}
	return undefined
}

const isNullable = (node: JsonSchema): boolean =>
	Array.isArray(node.type) && node.type.includes("null")

const convertNode = (node: JsonSchema, defs: Defs, depth: number): v.GenericSchema => {
	// Cheap cycle guard: Effect can emit mutually-referencing `$defs`, and a tool
	// parameter deep enough to hit this is past the point of being useful to a model.
	if (depth > 12) return v.unknown()

	if (typeof node.$ref === "string") {
		const target = resolveRef(node.$ref, defs)
		return target ? convertNode(target, defs, depth + 1) : v.unknown()
	}

	if ("const" in node) return describe(literal(node.const), node)

	const variants = node.anyOf ?? node.oneOf
	if (Array.isArray(variants) && variants.length > 0) {
		const members = variants.map((entry) => convertNode(asSchema(entry) ?? {}, defs, depth + 1))
		return describe(members.length === 1 ? members[0]! : v.union(members), node)
	}

	if (Array.isArray(node.enum) && node.enum.length > 0) {
		// A union of literals rather than `v.picklist`, which rejects booleans.
		const members = node.enum.map(literal)
		return describe(members.length === 1 ? members[0]! : v.union(members), node)
	}

	const base = convertTyped(node, defs, depth)
	return describe(isNullable(node) ? v.nullable(base) : base, node)
}

const convertTyped = (node: JsonSchema, defs: Defs, depth: number): v.GenericSchema => {
	switch (primaryType(node)) {
		case "object":
			return convertObject(node, defs, depth)
		case "array": {
			const items = asSchema(node.items)
			return v.array(items ? convertNode(items, defs, depth + 1) : v.unknown())
		}
		case "string":
			return v.string()
		case "integer":
			return v.pipe(v.number(), v.integer())
		case "number":
			return v.number()
		case "boolean":
			return v.boolean()
		case "null":
			return v.null()
		default:
			return v.unknown()
	}
}

const convertObject = (node: JsonSchema, defs: Defs, depth: number): v.GenericSchema => {
	const properties = asSchema(node.properties)
	if (!properties) {
		const additional = asSchema(node.additionalProperties)
		return v.record(v.string(), additional ? convertNode(additional, defs, depth + 1) : v.unknown())
	}

	const required = new Set(
		Array.isArray(node.required) ? node.required.filter((key): key is string => typeof key === "string") : [],
	)
	const entries: Record<string, v.GenericSchema> = {}
	for (const [key, raw] of Object.entries(properties)) {
		const property = convertNode(asSchema(raw) ?? {}, defs, depth + 1)
		entries[key] = required.has(key) ? property : v.optional(property)
	}
	return v.object(entries)
}

/**
 * Convert a tool's JSON Schema into the top-level Valibot **object** schema
 * `defineTool` requires. A schema that isn't an object (or that carries no
 * properties at all) becomes an empty object rather than being rejected — a
 * parameterless tool is legitimate.
 *
 * The declared output type is the widest honest one: the concrete property set
 * is only known at runtime (it arrives over RPC), so a tool's `run` receives a
 * record and reads what its own descriptor promised.
 */
export const jsonSchemaToValibot = (
	schema: Record<string, unknown>,
): v.GenericSchema<Record<string, unknown>, Record<string, unknown>> => {
	const defs: Defs = {}
	for (const key of ["$defs", "definitions"] as const) {
		const container = asSchema(schema[key])
		if (!container) continue
		for (const [name, value] of Object.entries(container)) {
			const entry = asSchema(value)
			if (entry) defs[name] = entry
		}
	}

	// `defineTool` asserts a top-level object schema; anything else (a bare
	// `unknown` from an unrecognised document) would throw at agent construction.
	const converted = convertNode(schema, defs, 0)
	return isRecordSchema(converted) ? converted : v.object({})
}

/** Narrows a converted node to the record-shaped schema `defineTool` accepts. */
const isRecordSchema = (
	schema: v.GenericSchema,
): schema is v.GenericSchema<Record<string, unknown>, Record<string, unknown>> =>
	schema.type === "object"
