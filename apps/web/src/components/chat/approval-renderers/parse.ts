export type ParseResult = { ok: true; value: unknown } | { ok: false }

export function safeParseJson(value: unknown): ParseResult {
	if (typeof value !== "string" || value.length === 0) return { ok: false }
	try {
		return { ok: true, value: JSON.parse(value) as unknown }
	} catch {
		return { ok: false }
	}
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>
	}
	return undefined
}

export function asArray(value: unknown): unknown[] | undefined {
	return Array.isArray(value) ? value : undefined
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined
}
