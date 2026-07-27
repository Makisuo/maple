import type { JsonValue } from "@flue/runtime"

/**
 * Coerce an arbitrary value into Flue's `JsonValue`.
 *
 * A tool's return value is validated and snapshotted by the runtime, which
 * throws on anything that isn't plain JSON — non-finite numbers, `undefined`,
 * class instances, cycles. Values that reach a tool from the model are already
 * JSON, but they arrive typed as `unknown`, and asserting that with a cast would
 * hide the one case that actually bites: a nested value the runtime would reject.
 * Converting is cheap (it runs once per tool call) and total.
 */
export const toJsonValue = (value: unknown, seen: WeakSet<object> = new WeakSet()): JsonValue => {
	if (value === null) return null
	if (typeof value === "string" || typeof value === "boolean") return value
	if (typeof value === "number") return Number.isFinite(value) ? value : null
	if (typeof value !== "object") return null
	if (seen.has(value)) return null
	seen.add(value)
	if (Array.isArray(value)) return value.map((entry) => toJsonValue(entry, seen))
	const record: { [key: string]: JsonValue } = {}
	for (const [key, entry] of Object.entries(value)) {
		if (entry === undefined) continue
		record[key] = toJsonValue(entry, seen)
	}
	return record
}
