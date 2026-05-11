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

const isHttpMethod = (s: string): s is HttpMethod => HTTP_METHODS.includes(s.toUpperCase() as HttpMethod)

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
			(p) => p.length === 1 && isHttpMethod(p[0]!),
			([method]) =>
				Option.some<NameInfo>({
					method: method!.toUpperCase(),
					routeHint: Option.none(),
				}),
		),
		Match.orElse(() => Option.none<NameInfo>()),
	)
}

const clientRouteFromAttrs = (attrs: Record<string, string>): Option.Option<string> => {
	// Prefer parsing url.full / http.url first — new URL() reliably strips the scheme.
	// Some emitters put a scheme into server.address, which would otherwise leak through.
	const fromFullUrl = pipe(Option.fromNullishOr(attrs["url.full"] ?? attrs["http.url"]), Option.flatMap(parseUrlHostPath))
	if (Option.isSome(fromFullUrl)) return fromFullUrl

	const host = (attrs["server.address"] ?? attrs["net.peer.name"])?.replace(/^https?:\/\//, "")
	const path = attrs["url.path"] ?? attrs["http.target"]
	if (host && path) return Option.some(`${host}${path}`)
	return Option.fromNullishOr(path)
}

const serverRouteFromAttrs = (attrs: Record<string, string>): Option.Option<string> =>
	Option.fromNullishOr(attrs["http.target"] ?? attrs["url.path"])

const routeFromAttrs = (attrs: Record<string, string>, isClient: boolean): Option.Option<string> =>
	pipe(
		Option.fromNullishOr(attrs["http.route"]),
		Option.orElse(() => (isClient ? clientRouteFromAttrs(attrs) : serverRouteFromAttrs(attrs))),
	)

/**
 * Extract HTTP span info from span name and attributes.
 * Handles multiple OTel conventions:
 * - Standard: `http.method`, `http.route`, `http.status_code`
 * - New semconv: `http.request.method`, `url.path`, `url.full`, `server.address`, `http.response.status_code`
 * - Span name patterns: `http.server GET /path`, `http.client GET https://host/path`, `GET /path`, bare `GET`
 *
 * Server spans render path-only (e.g. `/v1/spans`). Client spans render host+path
 * (e.g. `api.tinybird.co/v1/spans`) so the destination service is visible.
 */
export function getHttpInfo(spanName: string, attrs: Record<string, string>): HttpInfo | null {
	// Permissive: drives route extraction strategy. server spans can legitimately emit
	// url.full too, but if they do we still want to fall back to host+path composition.
	const useClientRoute = spanName.startsWith("http.client ") || !!attrs["url.full"] || !!attrs["http.url"]
	// Strict: only mark as client when the span name explicitly says so. Callers with
	// a real OTel span.kind value should pass it down and override this.
	const kind: "client" | "server" = spanName.startsWith("http.client ") ? "client" : "server"
	const nameInfo = parseSpanName(spanName)

	const method = pipe(
		Option.fromNullishOr(attrs["http.method"] ?? attrs["http.request.method"]),
		Option.orElse(() => Option.map(nameInfo, (n) => n.method)),
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

export const HTTP_METHOD_COLORS: Record<string, string> = {
	GET: "bg-[#4A9EFF]",
	POST: "bg-[#E8872B]",
	PUT: "bg-[#4AA865]",
	PATCH: "bg-[#8A7F72]",
	DELETE: "bg-[#E85D4A]",
	HEAD: "bg-[#8A7F72]",
	OPTIONS: "bg-[#5A5248]",
}
