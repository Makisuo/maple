import { makeResolveTenant } from "@maple/auth"
import { Effect, Layer, Option, Redacted } from "effect"
import {
	FetchHttpClient,
	HttpClient,
	HttpRouter,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/unstable/http"
import { SyncConfig } from "../config"

/**
 * ElectricSQL shape proxy — the standalone `apps/electric-sync` worker.
 *
 * Electric serves per-table "shapes" over HTTP but has no auth of its own — the
 * documented pattern is to proxy shape requests through your own service, which
 * pins the shape definition (table, WHERE, columns) server-side so a client can
 * only sub-filter within it. This route is that proxy: it authenticates the
 * caller from the Clerk / self-hosted session bearer (`makeResolveTenant`,
 * shared with `@maple/api`), injects the org-scoping `"org_id" = $1` predicate
 * that mirrors the warehouse OrgId enforcement, and forwards only Electric's
 * reserved cursor params from the client. The client sends `?shape=<name>` (a
 * Maple param) plus offset/handle/live/cursor; it never sees or sets the table
 * or WHERE.
 *
 * Unlike the old in-API route, there is NO API-key auth path here: this service
 * has no database, and the browser's shape-fetch only ever sends the session
 * bearer, so tenant resolution is the sole auth mechanism.
 */

// Server-pinned shape whitelist. Every shape is additionally org-scoped below;
// `extraWhere` narrows the synced rows further and `columns` restricts which
// columns Electric streams to the browser (drop encrypted secrets / large jsonb
// blobs — the client never needs them, and they must not leave the server). Both
// are immutable — changing either is a new shape name + full re-sync, so version
// the name if it must ever change. When `columns` is set it MUST include the
// table's primary-key column(s) (Electric requires the PK in the projection).
const SHAPES = {
	dashboards: { table: "dashboards" },
	alert_rules: { table: "alert_rules" },
	alert_rule_states: { table: "alert_rule_states" },
	alert_incidents: { table: "alert_incidents" },
	error_issues: { table: "error_issues", extraWhere: `"archived_at" IS NULL` },
	actors: { table: "actors" },
	open_error_incidents: { table: "error_incidents", extraWhere: `"status" = 'open'` },
	// API key hashes and agent metadata are authentication material/internal
	// configuration and must never reach the browser. The dashboard needs only
	// the safe display fields below; `id` + `org_id` are required for identity
	// and tenant scoping.
	api_keys: {
		table: "api_keys",
		columns: [
			"id",
			"org_id",
			"name",
			"description",
			"key_prefix",
			"revoked",
			"revoked_at",
			"last_used_at",
			"expires_at",
			"scopes",
			"kind",
			"created_at",
			"created_by",
			"created_by_email",
		],
	},
	// `config_json` holds only public config (summary / channel label / hazel
	// metadata); the encrypted webhook secrets live in separate `secret_*` columns
	// that MUST NOT reach the browser, so the projection drops them (and the
	// unused `created_by`/`updated_by`). The PK `id` is required in the projection.
	alert_destinations: {
		table: "alert_destinations",
		columns: [
			"id",
			"org_id",
			"name",
			"type",
			"enabled",
			"config_json",
			"last_tested_at",
			"last_test_error",
			"created_at",
			"updated_at",
		],
	},
} as const satisfies Record<
	string,
	{ readonly table: string; readonly extraWhere?: string; readonly columns?: ReadonlyArray<string> }
>

export type ShapeName = keyof typeof SHAPES

export const isShapeName = (value: string | null): value is ShapeName =>
	value !== null && Object.prototype.hasOwnProperty.call(SHAPES, value)

// The only client-supplied params we forward upstream. Everything else — table,
// where, columns, params[n] — is pinned by us, so a client can never widen the
// shape or escape its org scope. These are Electric's reserved cursor +
// cache-recovery params (see @electric-sql/client):
//   - offset / handle / live / cursor advance position in the log.
//   - expired_handle / cache-buster are cache-BUSTERS. Electric is designed to run
//     behind a caching CDN, and Cloudflare caches our upstream fetch to Electric
//     (Electric marks snapshot/log chunks `cache-control: public`). When Electric
//     rotates a shape handle (compaction), the client re-requests with these params
//     set so the new URL misses the stale CDN entry. DROPPING them makes the bust a
//     no-op: the upstream URL is byte-identical to the cached one, Cloudflare serves
//     the same stale response carrying the already-expired handle, and the client
//     spins in an infinite 409 refetch loop — the exact failure @electric-sql/client
//     warns about ("proxy/CDN is serving a stale cached response and ignoring
//     cache-buster query params"). They only affect caching, never the shape
//     definition or org scope, so forwarding them is safe.
const CLIENT_PASSTHROUGH_PARAMS = [
	"offset",
	"handle",
	"live",
	"cursor",
	"expired_handle",
	"cache-buster",
] as const

// Upstream response headers that must not survive re-wrapping: the platform
// re-encodes and re-chunks the streamed body, so a stale content-encoding /
// content-length would misdescribe it.
const STRIPPED_UPSTREAM_HEADERS = ["content-encoding", "content-length"]

/**
 * Adds `header` to a `Vary` header value without clobbering existing tokens or
 * duplicating (case-insensitive). A pre-existing `Vary: *` already defeats shared
 * caching, so it's left as-is.
 */
const appendVary = (existing: string | undefined, header: string): string => {
	const trimmed = existing?.trim()
	if (!trimmed) return header
	if (trimmed === "*") return trimmed
	const tokens = trimmed
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean)
	if (tokens.some((t) => t.toLowerCase() === header.toLowerCase())) return tokens.join(", ")
	return [...tokens, header].join(", ")
}

/**
 * Shapes the headers we return to the browser from an upstream Electric response.
 * Pure and exported so tests can assert the cache-isolation guarantees.
 *
 * Electric marks the initial snapshot / historical log chunks `cache-control:
 * public` so a CDN can fan them out. But our client-facing URL carries NO org — it
 * is `?shape=<name>&offset=…`, byte-identical for every tenant, with the org
 * derived from the bearer. A shared cache keyed on that URL would serve one org's
 * rows to another (the same cross-tenant leak the server-pinned `org_id` WHERE
 * exists to prevent, one layer up). So, per Electric's auth guide, we:
 *   - add `Vary: Authorization` so any compliant cache keys on the bearer (→ org);
 *   - downgrade `public` → `private` so no shared CDN/proxy holds an org's rows at
 *     all (live `no-store` responses are left untouched).
 * We also drop content-encoding/content-length, which misdescribe the re-wrapped
 * body. Effect lowercases header keys, so we match on lowercase names.
 */
export const shapeResponseHeaders = (upstream: Readonly<Record<string, string>>): Record<string, string> => {
	const headers: Record<string, string> = { ...upstream }
	for (const key of STRIPPED_UPSTREAM_HEADERS) delete headers[key]

	headers.vary = appendVary(headers.vary, "Authorization")

	const cacheControl = headers["cache-control"]
	if (cacheControl && /\bpublic\b/.test(cacheControl)) {
		headers["cache-control"] = cacheControl.replace(/\bpublic\b/g, "private")
	}

	return headers
}

/**
 * Builds the upstream Electric `/v1/shape` URL. Pure and exported so tests can
 * assert that a client can never override the pinned `table`/`where`/`params` —
 * only the whitelisted cursor params flow through.
 */
export const buildUpstreamShapeUrl = (args: {
	readonly electricUrl: string
	readonly shape: ShapeName
	readonly orgId: string
	readonly sourceId?: string | undefined
	readonly secret?: string | undefined
	readonly clientParams: URLSearchParams
}): string => {
	const def = SHAPES[args.shape]
	const base = args.electricUrl.replace(/\/+$/, "")
	const url = new URL(`${base}/v1/shape`)

	// Pinned server-side. Org scope is positional param $1 so the orgId value is
	// never interpolated into the WHERE string.
	url.searchParams.set("table", def.table)
	const orgWhere = `"org_id" = $1`
	url.searchParams.set(
		"where",
		"extraWhere" in def && def.extraWhere ? `${orgWhere} AND ${def.extraWhere}` : orgWhere,
	)
	url.searchParams.set("params[1]", args.orgId)

	// Column projection is pinned server-side too — a shape that drops secret /
	// oversized columns must never let the client widen it back to `SELECT *`.
	if ("columns" in def && def.columns) url.searchParams.set("columns", def.columns.join(","))

	// Electric Cloud source credentials (absent when self-hosting Electric).
	if (args.sourceId) url.searchParams.set("source_id", args.sourceId)
	if (args.secret) url.searchParams.set("secret", args.secret)

	for (const key of CLIENT_PASSTHROUGH_PARAMS) {
		const value = args.clientParams.get(key)
		if (value !== null) url.searchParams.set(key, value)
	}

	return url.toString()
}

const errorText = (message: string, status: number) =>
	HttpServerResponse.text(message, {
		status,
		headers: { "content-type": "text/plain; charset=utf-8" },
	})

export const ElectricSyncRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const config = yield* SyncConfig
		const client = yield* HttpClient.HttpClient
		const resolveTenant = makeResolveTenant(config)

		const electricUrl = Option.getOrUndefined(config.ELECTRIC_URL)
		const sourceId = Option.getOrUndefined(config.ELECTRIC_SOURCE_ID)
		const secret = Option.match(config.ELECTRIC_SECRET, {
			onNone: () => undefined,
			onSome: Redacted.value,
		})

		const handle = (req: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
				// Not configured (e.g. self-hosted without an Electric container) →
				// 503; the web app's collections degrade and it keeps using its
				// existing effect-atom fetches.
				if (!electricUrl) return errorText("Electric sync is not configured", 503)

				const requestUrl = new URL(req.url, "http://internal")
				const shapeParam = requestUrl.searchParams.get("shape")
				if (!isShapeName(shapeParam)) return errorText("Unknown or missing shape", 400)
				yield* Effect.annotateCurrentSpan("maple.sync.shape", shapeParam)

				// Auth: Clerk / self-hosted tenant resolution (covers both modes).
				const tenant = yield* resolveTenant(req.headers).pipe(Effect.option)
				if (Option.isNone(tenant)) return errorText("Unauthorized", 401)
				const orgId = tenant.value.orgId
				yield* Effect.annotateCurrentSpan("maple.org_id", orgId)

				const upstreamUrl = buildUpstreamShapeUrl({
					electricUrl,
					shape: shapeParam,
					orgId,
					sourceId,
					secret,
					clientParams: requestUrl.searchParams,
				})

				// Electric `live` requests long-poll, then return a COMPLETE response
				// (not an open SSE stream), and control-plane shapes are small, so we
				// buffer the body rather than manage a scoped pass-through stream.
				const result = yield* client.get(upstreamUrl).pipe(
					Effect.flatMap((response) =>
						response.text.pipe(Effect.map((body) => ({ response, body }))),
					),
					Effect.tapError((error) =>
						Effect.logWarning("Electric shape upstream request failed").pipe(
							Effect.annotateLogs({ shape: shapeParam, error: String(error) }),
						),
					),
					Effect.option,
				)
				if (Option.isNone(result)) return errorText("Electric upstream unreachable", 502)
				const { response, body } = result.value

				// Cache-isolate the org-scoped body (Vary: Authorization + no public
				// caching) and drop headers that misdescribe the re-serialized body.
				return HttpServerResponse.raw(body, {
					status: response.status,
					headers: shapeResponseHeaders(response.headers),
				})
			}).pipe(Effect.withSpan("ElectricSync.shape"))

		yield* router.add("GET", "/api/sync/shape", handle)
	}),
).pipe(Layer.provide(FetchHttpClient.layer))
