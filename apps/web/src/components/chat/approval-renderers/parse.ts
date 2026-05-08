export type ParseResult<T = unknown> = { ok: true; value: T } | { ok: false }

export function safeParseJson<T = unknown>(value: unknown): ParseResult<T> {
	if (typeof value !== "string" || value.length === 0) return { ok: false }
	try {
		return { ok: true, value: JSON.parse(value) as T }
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
