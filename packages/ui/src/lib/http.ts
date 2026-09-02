import { Match, Option, pipe } from "effect"

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const
type HttpMethod = (typeof HTTP_METHODS)[number]

export interface HttpInfo {
	method: string
	route: string | null
	statusCode: number | null
	isError: boolean
	kind: "client" | "server"
}

export interface HttpSpanInput {
	spanName: string
	spanAttributes?: Record<string, string>
	/** OTel SPAN_KIND_* — authoritative client/server signal when present. */
	spanKind?: string
}

const isHttpMethod = (s: string): s is HttpMethod => HTTP_METHODS.includes(s.toUpperCase() as HttpMethod)

/**
 * Reads the first of `keys` whose value is present and non-blank. Some emitters send
 * `http.request.method: ""` or `http.route: ""`; treating those as absent stops
 * `getHttpInfo` from rendering an empty method badge or a blank route.
 */
const attr = (attrs: Record<string, string>, ...keys: string[]): Option.Option<string> => {
	for (const key of keys) {
		const value = attrs[key]
		if (value != null && value.trim() !== "") return Option.some(value)
	}
	return Option.none()
}

const nonEmpty = (s: string): Option.Option<string> => (s.trim() !== "" ? Option.some(s) : Option.none())

const tryParseUrl = Option.liftThrowable((s: string) => new URL(s))

const parseUrlHostPath = (raw: string): Option.Option<string> =>
	pipe(
		tryParseUrl(raw),
		Option.map((u) => `${u.host}${u.pathname}`),
	)

interface NameInfo {
	method: string
	routeHint: Option.Option<string>
}

const parseSpanName = (name: string): Option.Option<NameInfo> => {
	const parts = name.split(" ")
	return Match.value(parts).pipe(
		Match.when(
			(p): p is [string, string, ...string[]] =>
				p.length >= 2 && (p[0] === "http.server" || p[0] === "http.client"),
			([, method, ...rest]) =>
				Option.some<NameInfo>({
					method,
					routeHint: rest.length > 0 ? Option.some(rest.join(" ")) : Option.none(),
				}),
		),
		Match.when(
			(p): p is [string, string, ...string[]] => p.length >= 2 && isHttpMethod(p[0]),
			([method, ...rest]) =>
				Option.some<NameInfo>({
					method: method.toUpperCase(),
					routeHint: Option.some(rest.join(" ")),
				}),
		),
		Match.when(
			(p): p is [string] => p.length === 1 && isHttpMethod(p[0]),
			([method]) =>
				Option.some<NameInfo>({
					method: method.toUpperCase(),
					routeHint: Option.none(),
				}),
		),
		Match.orElse(() => Option.none<NameInfo>()),
	)
}

const clientRouteFromAttrs = (attrs: Record<string, string>): Option.Option<string> => {
	// Prefer parsing url.full / http.url first — new URL() reliably strips the scheme.
	// Some emitters put a scheme into server.address, which would otherwise leak through.
	const fromFullUrl = pipe(attr(attrs, "url.full", "http.url"), Option.flatMap(parseUrlHostPath))
	if (Option.isSome(fromFullUrl)) return fromFullUrl

	const host = pipe(
		attr(attrs, "server.address", "net.peer.name"),
		Option.map((h) => h.replace(/^https?:\/\//, "")),
		Option.flatMap(nonEmpty),
	)
	const path = attr(attrs, "url.path", "http.target")
	if (Option.isSome(host) && Option.isSome(path)) return Option.some(`${host.value}${path.value}`)
	return path
}

const serverRouteFromAttrs = (attrs: Record<string, string>): Option.Option<string> =>
	attr(attrs, "http.target", "url.path")

const routeFromAttrs = (attrs: Record<string, string>, isClient: boolean): Option.Option<string> =>
	pipe(
		attr(attrs, "http.route"),
		Option.orElse(() => (isClient ? clientRouteFromAttrs(attrs) : serverRouteFromAttrs(attrs))),
	)

/**
 * Extract HTTP span info from a span's name, attributes, and (when known) OTel kind.
 * Handles multiple OTel conventions:
 * - Standard: `http.method`, `http.route`, `http.status_code`
 * - New semconv: `http.request.method`, `url.path`, `url.full`, `server.address`, `http.response.status_code`
 * - Span name patterns: `http.server GET /path`, `http.client GET https://host/path`, `GET /path`, bare `GET`
 *
 * Server spans render path-only (e.g. `/v1/spans`). Client spans render host+path
 * (e.g. `api.tinybird.co/v1/spans`) so the destination service is visible.
 *
 * Takes the span object so `spanKind` always rides along — the hierarchy query rewrites
 * span names (`http.client GET` → `GET /path`), which would otherwise hide the client
 * kind and collapse the route to path-only.
 */
export function getHttpInfo({ spanName, spanAttributes, spanKind }: HttpSpanInput): HttpInfo | null {
	const attrs = spanAttributes ?? {}

	// A real OTel span.kind is authoritative. Fall back to the name/url.full heuristic
	// only when the kind is absent or non-HTTP (INTERNAL/PRODUCER/CONSUMER).
	const kind: "client" | "server" = Match.value(spanKind).pipe(
		Match.when("SPAN_KIND_CLIENT", () => "client" as const),
		Match.when("SPAN_KIND_SERVER", () => "server" as const),
		Match.orElse(() => (spanName.startsWith("http.client ") ? "client" : "server")),
	)
	// server spans can legitimately emit url.full too, but if they do we still want to
	// fall back to host+path composition.
	const useClientRoute = kind === "client" || Option.isSome(attr(attrs, "url.full", "http.url"))
	const nameInfo = parseSpanName(spanName)

	const method = pipe(
		attr(attrs, "http.method", "http.request.method"),
		Option.orElse(() =>
			pipe(
				nameInfo,
				Option.flatMap((n) => nonEmpty(n.method)),
			),
		),
	)
	if (Option.isNone(method)) return null

	const route = pipe(
		routeFromAttrs(attrs, useClientRoute),
		Option.orElse(() =>
			pipe(
				nameInfo,
				Option.flatMap((n) => n.routeHint),
				Option.map((hint) => Option.getOrElse(parseUrlHostPath(hint), () => hint)),
			),
		),
		Option.getOrNull,
	)

	const rawStatus = attrs["http.status_code"] ?? attrs["http.response.status_code"]
	const statusCode = rawStatus ? parseInt(rawStatus, 10) || null : null

	return {
		method: method.value.toUpperCase(),
		route,
		statusCode,
		isError: statusCode != null && statusCode >= 500,
		kind,
	}
}

/**
 * Raw hex per HTTP method — the single source of truth for method colors.
 * Chart series, badges, and the mobile app all derive from these values.
 */
export const HTTP_METHOD_HEX: Record<string, string> = {
	GET: "#4A9EFF",
	POST: "#E8872B",
	PUT: "#4AA865",
	PATCH: "#8A7F72",
	DELETE: "#E85D4A",
	HEAD: "#8A7F72",
	OPTIONS: "#5A5248",
} satisfies Record<string, string>

// Kept as literals (not derived from HTTP_METHOD_HEX) because Tailwind's JIT
// scanner can't see class names built from template strings. A colocated test
// asserts the two maps agree.
export const HTTP_METHOD_COLORS: Record<string, string> = {
	GET: "bg-[#4A9EFF]",
	POST: "bg-[#E8872B]",
	PUT: "bg-[#4AA865]",
	PATCH: "bg-[#8A7F72]",
	DELETE: "bg-[#E85D4A]",
	HEAD: "bg-[#8A7F72]",
	OPTIONS: "bg-[#5A5248]",
} satisfies Record<string, string>
