// The local Maple server: OTLP/HTTP ingest + a raw SQL query API + the bundled
// SPA, all on one port, backed by an embedded chDB. Replaces the Rust
// `apps/ingest/src/bin/local.rs`. `maple start` calls `startServer`.

import { Effect, Schema, type Scope } from "effect"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { gunzipSync } from "node:zlib"
import { TelemetryLayer } from "../core/telemetry"
import { isLoopbackHostname } from "../lib/local-address"
import { acquireChdb, type Chdb, type ChdbError } from "./chdb"
import { buildInsertStatements } from "./inserts"
import { encodeLogs, encodeMetrics, encodeTraces, type EncodedBatch } from "./otlp/encode"
import { decodeLogsRequest, decodeMetricsRequest, decodeTraceRequest } from "./otlp/proto"
import schemaSql from "./schema/local-schema.sql" with { type: "text" }
import { schemaFingerprint } from "./store-version"

/** Fingerprint of the schema this build bootstraps stores with. Stamped into the
 *  store marker so `maple start` can rebuild a store left on an older schema. */
export const SCHEMA_FINGERPRINT = schemaFingerprint(schemaSql)

/** Resolves a request path to a static asset (the bundled SPA). Returns
 *  `undefined` to fall through to the SPA shell (client-side routing). */
export interface AssetResolver {
	(pathname: string): { readonly body: Uint8Array | string; readonly contentType: string } | undefined
}

export interface ServerOptions {
	readonly hostname: string
	/** URL hostnames permitted to use the embedded UI same-origin. This also
	 * rejects browser DNS-rebinding hosts that were never advertised. */
	readonly browserHosts: readonly string[]
	/** Exact separately hosted UI origin allowed to reach the local listener. */
	readonly corsOrigin: string
	readonly port: number
	readonly dataDir: string
	readonly configFile?: string
	/** Serves the bundled SPA; omit to disable the UI (API-only). */
	readonly assets?: AssetResolver
}

export class ServerBindError extends Schema.TaggedErrorClass<ServerBindError>()(
	"@maple/cli/ServerBindError",
	{
		hostname: Schema.String,
		port: Schema.Number,
		message: Schema.String,
	},
) {}

export const isBrowserOriginAllowed = (
	requestUrl: URL,
	origin: string | null,
	corsOrigin: string,
	browserHosts: readonly string[],
): boolean => {
	if (origin === null) return true // SDKs, collectors, and other non-browser clients
	let originUrl: URL
	try {
		originUrl = new URL(origin)
	} catch {
		return false
	}
	if (originUrl.origin === corsOrigin) return true
	// Loopback aliases and dev-proxy ports are equivalent local origins. Require
	// both sides to be loopback so this exception cannot weaken LAN DNS-rebinding
	// protection.
	if (isLoopbackHostname(originUrl.hostname) && isLoopbackHostname(requestUrl.hostname)) return true
	// Bun constructs requestUrl from the client's Host header. Keep that behavior:
	// this comparison is the load-bearing DNS-rebinding check for non-loopback UI traffic.
	// Compare host (including port), not scheme: a TLS reverse proxy may preserve
	// Host while forwarding to this HTTP listener. Restrict the hostname to the
	// bind/connect/advertised set so a DNS-rebinding origin cannot claim itself as
	// a same-origin embedded dashboard.
	return originUrl.host === requestUrl.host && browserHosts.includes(originUrl.hostname)
}

/** Build CORS headers for an origin that has already passed
 * `isBrowserOriginAllowed`. Echoing it preserves browser OTLP ingest between
 * loopback aliases and ports without restoring wildcard CORS. */
export const corsHeadersForAllowedOrigin = (
	origin: string | null,
): Readonly<Record<string, string>> | undefined =>
	origin !== null
		? {
				"access-control-allow-origin": origin,
				"access-control-allow-methods": "GET, POST, OPTIONS",
				"access-control-allow-headers": "content-type, content-encoding",
				"access-control-allow-private-network": "true",
				vary: "Origin",
			}
		: undefined

const withCors = (response: Response, headers: Readonly<Record<string, string>> | undefined): Response => {
	if (headers) for (const [name, value] of Object.entries(headers)) response.headers.set(name, value)
	return response
}

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	})

const text = (body: string, status = 200, contentType = "text/plain"): Response =>
	new Response(body, { status, headers: { "content-type": contentType } })

type Signal = "traces" | "logs" | "metrics"

/** Decode an OTLP request body (protobuf by default, JSON when content-type
 *  says so), transparently gunzipping a gzip content-encoding. */
function decodeOtlp(
	signal: Signal,
	raw: Uint8Array,
	contentType: string,
	contentEncoding: string | null,
): unknown {
	let bytes = raw
	if (contentEncoding && contentEncoding.includes("gzip")) {
		bytes = gunzipSync(raw)
	}
	const isJson = contentType.includes("json")
	if (isJson) {
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown
	}
	switch (signal) {
		case "traces":
			return decodeTraceRequest(bytes)
		case "logs":
			return decodeLogsRequest(bytes)
		case "metrics":
			return decodeMetricsRequest(bytes)
	}
}

function encodeFor(signal: Signal, req: unknown): EncodedBatch[] {
	switch (signal) {
		case "traces":
			return encodeTraces(req)
		case "logs":
			return encodeLogs(req)
		case "metrics":
			return encodeMetrics(req)
	}
}

interface IngestResult {
	readonly response: Response
	readonly accepted: number
	readonly requestBytes: number
}

async function ingest(db: Chdb, signal: Signal, req: Request): Promise<IngestResult> {
	const raw = new Uint8Array(await req.arrayBuffer())
	const requestBytes = raw.length
	const contentType = req.headers.get("content-type") ?? ""
	const contentEncoding = req.headers.get("content-encoding")
	let decoded: unknown
	try {
		decoded = decodeOtlp(signal, raw, contentType, contentEncoding)
	} catch (error) {
		return {
			response: text(`decode ${signal}: ${(error as Error).message}`, 400),
			accepted: 0,
			requestBytes,
		}
	}
	let batches: EncodedBatch[]
	try {
		batches = encodeFor(signal, decoded)
	} catch (error) {
		return {
			response: text(`encode ${signal}: ${(error as Error).message}`, 500),
			accepted: 0,
			requestBytes,
		}
	}
	let accepted = 0
	for (const batch of batches) {
		if (batch.rowCount === 0) continue
		for (const statement of buildInsertStatements(batch.datasource, batch.ndjson)) {
			try {
				db.exec(statement.sql)
			} catch (error) {
				return {
					response: text(`chDB insert (${batch.datasource}): ${(error as Error).message}`, 500),
					accepted,
					requestBytes,
				}
			}
			accepted += statement.rowCount
		}
	}
	return { response: json({ accepted }), accepted, requestBytes }
}

/**
 * Strip a trailing `FORMAT <ident>` clause (optionally followed by `;`) and
 * re-append `FORMAT JSONEachRow`, so the server owns the output format. Port of
 * `force_json_each_row` from the former Rust server: callers POST `compiled.sql`
 * verbatim (`CH.compile(...)` appends `FORMAT JSON`).
 */
function forceJsonEachRow(sql: string): string {
	let s = sql.trimEnd()
	if (s.endsWith(";")) s = s.slice(0, -1).trimEnd()
	const lower = s.toLowerCase()
	const pos = lower.lastIndexOf("format")
	if (pos !== -1) {
		const beforeOk = pos === 0 || /\s/.test(s[pos - 1]!)
		const rest = s.slice(pos + "format".length)
		const afterOk = rest.length > 0 && /\s/.test(rest[0]!)
		const ident = rest.trim()
		const isIdent = ident.length > 0 && /^[A-Za-z0-9_]+$/.test(ident)
		if (beforeOk && afterOk && isIdent) s = s.slice(0, pos).trimEnd()
	}
	return `${s}\nFORMAT JSONEachRow`
}

interface QueryResult {
	readonly response: Response
	readonly rowCount: number
	readonly durationMs: number
	readonly sql: string | undefined
}

async function handleQuery(db: Chdb, req: Request): Promise<QueryResult> {
	let sql: string
	try {
		const body = (await req.json()) as { sql?: unknown }
		if (typeof body.sql !== "string")
			return { response: text("missing 'sql' string", 400), rowCount: 0, durationMs: 0, sql: undefined }
		sql = body.sql
	} catch {
		return { response: text("invalid JSON body", 400), rowCount: 0, durationMs: 0, sql: undefined }
	}
	let out: string
	const started = performance.now()
	try {
		out = db.query(forceJsonEachRow(sql))
	} catch (error) {
		// 400, not 500: a failing statement is a problem with the submitted SQL,
		// and a 5xx would make the shared warehouse executor classify it as a
		// transient upstream error and retry the identical query.
		return {
			response: text(`query failed: ${(error as Error).message}`, 400),
			rowCount: 0,
			durationMs: Math.round(performance.now() - started),
			sql,
		}
	}
	const durationMs = Math.round(performance.now() - started)
	// chDB returns JSONEachRow (one JSON object per line). Wrap the lines into a
	// JSON array without re-parsing each row.
	const rows = out
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
	return {
		response: text(`[${rows.join(",")}]`, 200, "application/json"),
		rowCount: rows.length,
		durationMs,
		sql,
	}
}

function serveAsset(assets: AssetResolver, pathname: string): Response {
	const path = pathname === "/" ? "index.html" : pathname.replace(/^\//, "")
	const hit = assets(path)
	if (hit) return new Response(hit.body, { headers: { "content-type": hit.contentType } })
	// Unknown path → serve the SPA shell so the client router can take over.
	const shell = assets("index.html")
	if (shell) return new Response(shell.body, { headers: { "content-type": "text/html" } })
	return text("UI not built", 404)
}

// Cap `db.query.text` at 16 KB to match apps/api's WarehouseQueryService span.
const MAX_DB_QUERY_TEXT = 16 * 1024
const truncateSql = (sql: string) => (sql.length > MAX_DB_QUERY_TEXT ? sql.slice(0, MAX_DB_QUERY_TEXT) : sql)

/** Runs a request's span effect on the server's tracing runtime (see
 *  `startServer`). The effect always succeeds with a `Response`. */
type SpanRunner = <A>(effect: Effect.Effect<A>) => Promise<A>

// A rejected 5xx ingest/query response, surfaced through the Effect error
// channel. `message` carries the handler's descriptive body so the span records
// a real `exception.message`; `response` is the original, untouched response we
// hand back to the client in `recoverResponse`. (Failing with a bare `Response`
// recorded an empty `{}` — a `Response` has no enumerable own fields — which lost
// the cause entirely and bucketed every failure under one "Error" fingerprint.)
class IngestRejected extends Schema.TaggedErrorClass<IngestRejected>()("@maple/cli/IngestRejected", {
	response: Schema.instanceOf(Response),
	status: Schema.Number,
	message: Schema.String,
}) {}

// The Effect tracer derives span status from the effect's outcome. OTel HTTP
// Server semantics treat 4xx as a successful server outcome (the caller sent a
// bad request) and only 5xx as Error. Annotate every rejection, but fail inside
// the Server span only for 5xx; recover the original response outside the span.
const recordServerResponse = (response: Response): Effect.Effect<Response, IngestRejected> =>
	Effect.gen(function* () {
		if (response.status >= 400) {
			// Clone to read the body without consuming the response we return below.
			const body = (yield* Effect.promise(() => response.clone().text())).trim()
			const message = body.length > 0 ? body : `HTTP ${response.status}`
			yield* Effect.annotateCurrentSpan({ "error.type": `HTTP ${response.status}` })
			if (response.status >= 500) {
				return yield* new IngestRejected({ response, status: response.status, message })
			}
		}
		return response
	})

const recoverResponse = (self: Effect.Effect<Response, IngestRejected>): Effect.Effect<Response> =>
	Effect.match(self, { onFailure: (error) => error.response, onSuccess: (response) => response })

/** OTLP-ingest request as a `Server`-kind span, mirroring the Rust gateway
 *  (`apps/ingest`): `maple.signal`, item count, request size, HTTP semconv. */
const ingestSpan = (runSpan: SpanRunner, db: Chdb, signal: Signal, req: Request): Promise<Response> =>
	runSpan(
		recoverResponse(
			Effect.gen(function* () {
				const { response, accepted, requestBytes } = yield* Effect.promise(() =>
					ingest(db, signal, req),
				)
				yield* Effect.annotateCurrentSpan({
					"http.request.body.size": requestBytes,
					"maple.ingest.item_count": accepted,
					"http.response.status_code": response.status,
				})
				return yield* recordServerResponse(response)
			}).pipe(
				Effect.withSpan(`POST /v1/${signal}`, {
					kind: "server",
					attributes: {
						"maple.signal": signal,
						"http.request.method": "POST",
						"http.route": `/v1/${signal}`,
					},
				}),
			),
		),
	)

/** `/local/query` request as a `Server`-kind span with the canonical DB attrs. */
const querySpan = (runSpan: SpanRunner, db: Chdb, req: Request): Promise<Response> =>
	runSpan(
		recoverResponse(
			Effect.gen(function* () {
				const { response, rowCount, durationMs, sql } = yield* Effect.promise(() =>
					handleQuery(db, req),
				)
				yield* Effect.annotateCurrentSpan({
					"db.system.name": "clickhouse",
					"db.duration_ms": durationMs,
					"result.rowCount": rowCount,
					"http.response.status_code": response.status,
					...(sql ? { "db.query.text": truncateSql(sql), "db.query.length": sql.length } : {}),
				})
				return yield* recordServerResponse(response)
			}).pipe(
				Effect.withSpan("POST /local/query", {
					kind: "server",
					attributes: { "http.request.method": "POST", "http.route": "/local/query" },
				}),
			),
		),
	)

/** The `Bun.serve` fetch handler, closed over the chDB connection. Each ingest
 *  and query request is run through `runSpan` so it leaves a trace; `/health`
 *  and `OPTIONS` are skipped (loop-prevention convention — no health-check noise). */
const makeFetch =
	(db: Chdb, options: ServerOptions, runSpan: SpanRunner) =>
	async (req: Request): Promise<Response> => {
		const url = new URL(req.url)
		const origin = req.headers.get("origin")
		if (!isBrowserOriginAllowed(url, origin, options.corsOrigin, options.browserHosts)) {
			return text("browser origin not allowed", 403)
		}
		const corsHeaders = corsHeadersForAllowedOrigin(origin)
		const respond = (response: Response): Response => withCors(response, corsHeaders)
		if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })
		if (url.pathname === "/health") return respond(text("OK"))
		if (req.method === "POST") {
			if (url.pathname === "/v1/traces") return respond(await ingestSpan(runSpan, db, "traces", req))
			if (url.pathname === "/v1/logs") return respond(await ingestSpan(runSpan, db, "logs", req))
			if (url.pathname === "/v1/metrics") return respond(await ingestSpan(runSpan, db, "metrics", req))
			if (url.pathname === "/local/query") return respond(await querySpan(runSpan, db, req))
		}
		if (req.method === "GET" && options.assets) return respond(serveAsset(options.assets, url.pathname))
		return respond(text("not found", 404))
	}

/** Start the server as a scoped resource. Opens chDB (bootstrapping the schema)
 *  before binding, so a failure surfaces before we accept traffic, and ties both
 *  the chDB connection and the listening socket to the current `Scope`. When the
 *  scope closes the socket stops first, then chDB closes (reverse acquisition
 *  order). Resolves with the bound port once listening. */
export const startServer = (
	options: ServerOptions,
): Effect.Effect<{ readonly port: number }, ChdbError | ServerBindError, Scope.Scope> =>
	Effect.gen(function* () {
		const db = yield* acquireChdb({
			dataDir: options.dataDir,
			schemaSql,
			configFile: options.configFile,
		})
		// A dedicated runtime carrying the OTel tracer for per-request spans: the
		// Bun.serve handler runs outside Effect, so each request's span effect is
		// run through this runtime. Disposed on scope close, which flushes any
		// pending spans (bounded by the layer's shutdownTimeout).
		const telemetry = yield* Effect.acquireRelease(
			Effect.sync(() => ManagedRuntime.make(TelemetryLayer)),
			(rt) => Effect.promise(() => rt.dispose()),
		)
		const runSpan: SpanRunner = (effect) => telemetry.runPromise(effect)
		const server = yield* Effect.acquireRelease(
			Effect.try({
				try: () =>
					Bun.serve({
						port: options.port,
						hostname: options.hostname,
						fetch: makeFetch(db, options, runSpan),
					}),
				catch: (error) =>
					new ServerBindError({
						hostname: options.hostname,
						port: options.port,
						message: `failed to bind ${options.hostname}:${options.port}: ${error instanceof Error ? error.message : String(error)}`,
					}),
			}),
			(s) => Effect.promise(() => s.stop(true)),
		)
		return { port: server.port ?? options.port }
	})

export const __testables = { recordServerResponse }
