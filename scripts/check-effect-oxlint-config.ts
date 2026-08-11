type JsonObject = Record<string, unknown>

const readObject = async (path: string): Promise<JsonObject> => {
	const value: unknown = await Bun.file(path).json()
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${path} must contain a JSON object`)
	}
	return value as JsonObject
}

const propertyObject = (object: JsonObject, property: string, source: string): JsonObject => {
	const value = object[property]
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${source}.${property} must be a JSON object`)
	}
	return value as JsonObject
}

const schemaPath = "node_modules/@effect/tsgo/oxlint-schema.json"
const readmePath = "node_modules/@effect/tsgo/README.md"
const configPath = ".oxlintrc.effect.json"

const schema = await readObject(schemaPath)
const definitions = propertyObject(schema, "definitions", schemaPath)
const dummyRuleMap = propertyObject(definitions, "DummyRuleMap", `${schemaPath}.definitions`)
const availableRules = propertyObject(dummyRuleMap, "properties", `${schemaPath}.definitions.DummyRuleMap`)
const readme = await Bun.file(readmePath).text()
const config = await readObject(configPath)
const configuredRules = propertyObject(config, "rules", configPath)

// `prefer-typed-schema-decoder` is registered by the runtime and documented in
// the README, but missing from 0.35.0's generated oxlint schema. Union both
// inventories so the guard checks what Oxlint can actually emit.
const documentedEffectRules = Array.from(
	readme.matchAll(/docs\/rules\/([a-z0-9-]+)\.md/g),
	([, rule]) => `effecttsgo/${rule}`,
)
const availableEffectRules = Array.from(
	new Set([
		...Object.keys(availableRules).filter((rule) => rule.startsWith("effecttsgo/")),
		...documentedEffectRules,
	]),
).sort()
const configuredEffectRules = Object.keys(configuredRules)
	.filter((rule) => rule.startsWith("effecttsgo/"))
	.sort()

const configuredSet = new Set(configuredEffectRules)
const availableSet = new Set(availableEffectRules)
const missing = availableEffectRules.filter((rule) => !configuredSet.has(rule))
const removed = configuredEffectRules.filter((rule) => !availableSet.has(rule))

if (missing.length > 0 || removed.length > 0) {
	if (missing.length > 0) {
		console.error(`Unreviewed Effect oxlint rules:\n${missing.map((rule) => `- ${rule}`).join("\n")}`)
	}
	if (removed.length > 0) {
		console.error(
			`Removed Effect oxlint rules still configured:\n${removed.map((rule) => `- ${rule}`).join("\n")}`,
		)
	}
	process.exitCode = 1
}
