// Log key — opaque, URL-safe identifier for a single log row.
//
// The ClickHouse `logs` table has no primary id. A row is identified by the
// composite of Timestamp (DateTime64, sub-second), ServiceName, TraceId and
// SpanId. `encodeLogKey` packs these into a base64url token usable as the
// `$logId` path segment of `/logs/$logId`; `decodeLogKey` reverses it and
// never throws — malformed input yields `null` so the page can render its
// "invalid link" state.

export interface LogKey {
	/** Raw Log.timestamp — ClickHouse DateTime64 string. */
	timestamp: string
	serviceName: string
	/** Empty string when the log has no trace context. */
	traceId: string
	/** Empty string when the log has no span context. */
	spanId: string
}

interface EncodableLog {
	timestamp: string
	serviceName: string
	traceId: string
	spanId: string
}

function toBase64Url(str: string): string {
	const bytes = new TextEncoder().encode(str)
	let binary = ""
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(token: string): string {
	const padded = token.replace(/-/g, "+").replace(/_/g, "/")
	const binary = atob(padded)
	const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
	return new TextDecoder().decode(bytes)
}

/** Encode a log's composite identity into a URL-safe token. */
export function encodeLogKey(log: EncodableLog): string {
	// Tuple form keeps the token compact; order is [ts, svc, traceId, spanId].
	const payload: [string, string, string, string] = [
		log.timestamp,
		log.serviceName,
		log.traceId ?? "",
		log.spanId ?? "",
	]
	return toBase64Url(JSON.stringify(payload))
}

/** Decode a `$logId` token back into a LogKey, or `null` if it is malformed. */
export function decodeLogKey(token: string): LogKey | null {
	try {
		const parsed = JSON.parse(fromBase64Url(token)) as unknown
		if (!Array.isArray(parsed) || parsed.length !== 4) return null
		const [timestamp, serviceName, traceId, spanId] = parsed
		if (
			typeof timestamp !== "string" ||
			typeof serviceName !== "string" ||
			typeof traceId !== "string" ||
			typeof spanId !== "string"
		) {
			return null
		}
		if (timestamp === "" || serviceName === "") return null
		return { timestamp, serviceName, traceId, spanId }
	} catch {
		return null
	}
}
