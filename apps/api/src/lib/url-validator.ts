import { Data, Effect } from "effect"

export class UrlValidationError extends Data.TaggedError("UrlValidationError")<{
	readonly message: string
	readonly url?: string
}> {}

const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"localhost.localdomain",
	"ip6-localhost",
	"ip6-loopback",
	"broadcasthost",
	"metadata.google.internal",
	"metadata.azure.com",
])

const PRIVATE_IPV4_PATTERNS: ReadonlyArray<RegExp> = [
	/^0(?:\.|$)/,
	/^10\./,
	/^127\./,
	/^169\.254\./,
	/^172\.(?:1[6-9]|2\d|3[01])\./,
	/^192\.168\./,
	/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
	/^198\.(?:1[8-9])\./,
	/^255\.255\.255\.255$/,
]

const PRIVATE_IPV6_PATTERNS: ReadonlyArray<RegExp> = [
	/^::1$/,
	/^::$/,
	/^fc[0-9a-f]{2}:/i,
	/^fd[0-9a-f]{2}:/i,
	/^fe80:/i,
	/^::ffff:127\./i,
	/^::ffff:10\./i,
	/^::ffff:169\.254\./i,
	/^::ffff:172\.(?:1[6-9]|2\d|3[01])\./i,
	/^::ffff:192\.168\./i,
	/^::ffff:0\./i,
]

const isPrivateIPv4 = (host: string): boolean => PRIVATE_IPV4_PATTERNS.some((re) => re.test(host))

const isPrivateIPv6 = (host: string): boolean => {
	const inner = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
	return PRIVATE_IPV6_PATTERNS.some((re) => re.test(inner))
}

const isPrivateHost = (hostname: string): boolean => {
	const lower = hostname.toLowerCase()
	if (BLOCKED_HOSTNAMES.has(lower)) return true
	if (isPrivateIPv4(lower)) return true
	if (isPrivateIPv6(lower)) return true
	return false
}

export const validateExternalUrlSync = (raw: string): URL => {
	const trimmed = raw.trim()
	if (trimmed.length === 0) {
		throw new UrlValidationError({ message: "URL is required" })
	}
	let parsed: URL
	try {
		parsed = new URL(trimmed)
	} catch {
		throw new UrlValidationError({ message: `Invalid URL: ${trimmed}`, url: trimmed })
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new UrlValidationError({
			message: `URL scheme '${parsed.protocol}' is not allowed; use http or https`,
			url: trimmed,
		})
	}
	if (parsed.hostname.length === 0) {
		throw new UrlValidationError({ message: "URL must include a hostname", url: trimmed })
	}
	if (isPrivateHost(parsed.hostname)) {
		throw new UrlValidationError({
			message: `URL host '${parsed.hostname}' is not allowed (loopback, private, or metadata range)`,
			url: trimmed,
		})
	}
	return parsed
}

export const validateExternalUrl = (raw: string): Effect.Effect<URL, UrlValidationError> =>
	Effect.try({
		try: () => validateExternalUrlSync(raw),
		catch: (error) =>
			error instanceof UrlValidationError
				? error
				: new UrlValidationError({
						message: error instanceof Error ? error.message : "URL validation failed",
						url: raw,
					}),
	})

const MAX_REDIRECTS = 5

export interface SafeFetchOptions extends RequestInit {
	readonly fetchFn?: typeof fetch
}

export const safeFetch = async (initialUrl: string, init: SafeFetchOptions = {}): Promise<Response> => {
	const fetchFn = init.fetchFn ?? fetch
	let currentUrl = initialUrl
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const validated = validateExternalUrlSync(currentUrl)
		const response = await fetchFn(validated.toString(), { ...init, redirect: "manual" })
		if (response.status < 300 || response.status >= 400) return response
		const location = response.headers.get("location")
		if (!location) return response
		currentUrl = new URL(location, validated).toString()
	}
	throw new UrlValidationError({
		message: `Too many redirects (>${MAX_REDIRECTS})`,
		url: initialUrl,
	})
}
