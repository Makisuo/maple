export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const

export interface HttpInfo {
	method: string
	route: string | null
	statusCode: number | null
	isError: boolean
}

/**
 * Extract HTTP span info from span name and attributes.
 * Handles multiple OTel conventions:
 * - Standard: `http.method`, `http.route`, `http.status_code`
 * - New semconv: `http.request.method`, `url.path`, `http.response.status_code`
 * - Span name patterns: "GET /path", "http.server GET", bare "GET"
 */
export function getHttpInfo(spanName: string, attrs: Record<string, string>): HttpInfo | null {
	let method = attrs["http.method"] || attrs["http.request.method"]
	let route: string | null = attrs["http.route"] || attrs["http.target"] || attrs["url.path"] || null

	if (!method) {
		const parts = spanName.split(" ")
		if (spanName.startsWith("http.server ") && parts.length >= 2) {
			method = parts[1]
			if (!route && parts.length >= 3) route = parts.slice(2).join(" ")
		} else if (
			parts.length >= 2 &&
			HTTP_METHODS.includes(parts[0].toUpperCase() as (typeof HTTP_METHODS)[number])
		) {
			method = parts[0].toUpperCase()
			if (!route) route = parts.slice(1).join(" ")
		} else if (HTTP_METHODS.includes(spanName.toUpperCase() as (typeof HTTP_METHODS)[number])) {
			method = spanName.toUpperCase()
		}
	}

	if (!method) return null

	const rawStatus = attrs["http.status_code"] || attrs["http.response.status_code"]
	const statusCode = rawStatus ? parseInt(rawStatus, 10) || null : null

	return {
		method: method.toUpperCase(),
		route,
		statusCode,
		isError: statusCode != null && statusCode >= 500,
	}
}

export const HTTP_METHOD_COLORS: Record<string, string> = {
	GET: "bg-[#4A9EFF]",
	POST: "bg-[#E8872B]",
	PUT: "bg-[#4AA865]",
	PATCH: "bg-[#8A7F72]",
	DELETE: "bg-[#E85D4A]",
	HEAD: "bg-[#8A7F72]",
	OPTIONS: "bg-[#5A5248]",
}
