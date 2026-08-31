import { Effect, Schema } from "effect"

export class UrlValidationError extends Schema.TaggedError<UrlValidationError>()(
	"@maple/api/lib/UrlValidationError",
	{
		message: Schema.String,
		url: Schema.optional(Schema.String),
	},
) {}

const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"localhost.localdomain",
	"ip6-localhost",
	"ip6-loopback",
	"broadcasthost",
	"metadata",
	"metadata.google.internal",
	"metadata.goog",
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
	// IETF protocol assignments — `192.0.0.192` is Oracle Cloud's metadata address.
	/^192\.0\.0\./,
	// Documentation ranges: never routable, so a request to one is a probe.
	/^192\.0\.2\./,
	/^198\.51\.100\./,
	/^203\.0\.113\./,
	// Multicast (224/4) and reserved (240/4).
	/^(?:22[4-9]|23\d)\./,
	/^(?:24\d|25[0-5])\./,
]

const PRIVATE_IPV6_PATTERNS: ReadonlyArray<RegExp> = [
	/^::1$/,
	/^::$/,
	/^fc[0-9a-f]{2}:/i,
	/^fd[0-9a-f]{2}:/i,
	// Link-local is `fe80::/10` — `fe80:` alone is `/16`, which let `fe9f::1`,
	// `fea0::1` and everything up to `febf:…` through.
	/^fe[89ab][0-9a-f]:/i,
	// Site-local: deprecated, still routed on plenty of internal networks.
	/^fe[cdef][0-9a-f]:/i,
]

// Transition mechanisms that carry an IPv4 destination inside an IPv6 address:
// the packet ends up at the embedded address, so it has to face the IPv4 rules.
// `2002:7f00:0001::` is 6to4 for 127.0.0.1; `64:ff9b::7f00:1` is NAT64.
const SIX_TO_FOUR_RE = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i
const NAT64_RE = /^64:ff9b(?::0)*::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i
const NAT64_DOTTED_RE = /^64:ff9b(?::0)*::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i

// IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) are canonicalised by most URL
// parsers to the hex form `::ffff:HHHH:HHHH`, with leading zeros stripped from
// each group (e.g. `10.0.0.1` → `::ffff:a00:1`). Decode the hex back to
// dotted-quad and apply the IPv4 private-range check.
const IPV4_MAPPED_RE = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i
const IPV4_MAPPED_DOTTED_RE = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i

const decodeIPv4MappedIPv6 = (inner: string): string | null => {
	const dotted = IPV4_MAPPED_DOTTED_RE.exec(inner)
	if (dotted) return dotted[1]
	const hex = IPV4_MAPPED_RE.exec(inner)
	if (!hex) return null
	const hi = Number.parseInt(hex[1], 16)
	const lo = Number.parseInt(hex[2], 16)
	if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi > 0xffff || lo > 0xffff) return null
	return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
}

/**
 * The patterns above are prefix matches, which is only sound against something
 * already known to be an IPv4 literal: `/^10\./` says yes to the perfectly
 * ordinary hostname `10.example.com`, and the widened multicast and reserved
 * ranges would do the same to `240.example.com`. A URL parser normalises every
 * accepted IPv4 form — decimal, octal, hex — to a dotted quad, so anything that
 * is an address at all reaches here looking like one.
 */
const IPV4_LITERAL_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/

const isPrivateIPv4 = (host: string): boolean =>
	IPV4_LITERAL_RE.test(host) && PRIVATE_IPV4_PATTERNS.some((re) => re.test(host))

const hexPairToDotted = (hi: string, lo: string): string | null => {
	const high = Number.parseInt(hi, 16)
	const low = Number.parseInt(lo, 16)
	if (!Number.isFinite(high) || !Number.isFinite(low) || high > 0xffff || low > 0xffff) return null
	return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`
}

/** The IPv4 address an IPv6 literal ultimately delivers to, if it embeds one. */
const embeddedIPv4 = (inner: string): string | null => {
	const mapped = decodeIPv4MappedIPv6(inner)
	if (mapped) return mapped
	const nat64Dotted = NAT64_DOTTED_RE.exec(inner)
	if (nat64Dotted) return nat64Dotted[1]
	const nat64 = NAT64_RE.exec(inner)
	if (nat64) return hexPairToDotted(nat64[1], nat64[2])
	const sixToFour = SIX_TO_FOUR_RE.exec(inner)
	if (sixToFour) return hexPairToDotted(sixToFour[1], sixToFour[2])
	return null
}

const isPrivateIPv6 = (host: string): boolean => {
	const inner = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
	if (PRIVATE_IPV6_PATTERNS.some((re) => re.test(inner))) return true
	const embedded = embeddedIPv4(inner)
	if (embedded && isPrivateIPv4(embedded)) return true
	return false
}

/**
 * A trailing dot makes a name fully qualified — `localhost.` and `localhost`
 * resolve identically — but it is kept verbatim by the URL parser, so a blocklist
 * keyed on the bare name never matched it. Strip it before every name comparison.
 */
const canonicalHostname = (hostname: string): string => {
	const lower = hostname.toLowerCase()
	return lower.endsWith(".") ? lower.slice(0, -1) : lower
}

const isPrivateHost = (hostname: string): boolean => {
	const lower = canonicalHostname(hostname)
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
	// Credentials in the URL are both a way to smuggle a second host past a
	// reader (`https://real.example.com@internal/`, where the parser's host is
	// `internal`) and a way to have Maple replay them at the destination.
	if (parsed.username !== "" || parsed.password !== "") {
		throw new UrlValidationError({
			message: "URL must not embed credentials",
			url: trimmed,
		})
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
