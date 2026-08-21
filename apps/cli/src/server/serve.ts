// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
// The local Maple server: OTLP/HTTP ingest + a raw SQL query API + the bundled
// SPA, all on one port, backed by an embedded chDB. Replaces the Rust
// `apps/ingest/src/bin/local.rs`. `maple start` calls `startServer`.

import { Effect, Predicate, Schema, type Scope } from "effect"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { gunzipSync } from "node:zlib"
import { TelemetryLayer } from "../core/telemetry"
import { isLoopbackHostname } from "../lib/local-address"
import { MAPLE_VERSION } from "../version"
import {
	acquireChdb,
	type Chdb,
	ChdbError,
	configureRawTelemetryRetentionDays,
	readRawTelemetryRetentionDays,
	rawTelemetryTtlStatements,
} from "./chdb"
import { buildInsertStatements } from "./inserts"
import {
	eventingControlSnapshotPath,
	EventConsumerConflictError,
	EventConsumerInputError,
	EventConsumerNotFoundError,
	LocalEventingControlStore,
} from "./eventing/control-store"
import { ensureEventConsumerToken, eventConsumerTokenMatches } from "./eventing/consumer-auth"
import { LocalEventingRuntime } from "./eventing/runtime"
import { makeEffectEventingTelemetry } from "./eventing/telemetry"
import { encodeLogs, encodeMetrics, encodeTraces, type EncodedBatch, OtlpFieldError } from "./otlp/encode"
import {
	decodeLogsRequest,
	decodeMetricsRequest,
	decodeTraceRequest,
	encodeExportResponse,
} from "./otlp/proto"
import { CURRENT_LOCAL_SCHEMA, LOCAL_SCHEMA_SQL, SCHEMA_FINGERPRINT } from "./schema-identity"
import { assertCurrentPhysicalSchema } from "./schema-physical"
import { ensureStoreMarkerDurable } from "./store-version"
import {
	ensureMaintenanceToken,
	maintenanceTokenMatches,
	RetiredDayAuthority,
	retireLiveDayInServer,
} from "./archives/retention"

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
	readonly minimumRawTelemetryRetentionDays?: number
	/** Serves the bundled SPA; omit to disable the UI (API-only). */
	readonly assets?: AssetResolver
}

export class ServerBindError extends Schema.TaggedError<ServerBindError>()("@maple/cli/ServerBindError", {
	hostname: Schema.String,
	port: Schema.Number,
	message: Schema.String,
}) {}

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
 * loopback aliases and ports without restoring wildcard CORS.
 *
 * `authorization` is allowed because every browser SDK sends
 * `Authorization: Bearer <ingest key>` once one is configured — the same bundle
 * that ships to production is what people point at `maple start`. Rejecting the
 * header in preflight blocked those pages entirely (and `@maple-dev/browser`,
 * which requires an ingest key, could never reach local mode at all). Nothing
 * is weakened by allowing it: this listener authenticates nothing, it gates on
 * request origin, and `/v1/*` never reads the header's value. */
export const corsHeadersForAllowedOrigin = (
	origin: string | null,
): Readonly<Record<string, string>> | undefined =>
	origin !== null
		? {
				"access-control-allow-origin": origin,
				"access-control-allow-methods": "GET, POST, OPTIONS",
				// `x-maple-sdk` is the SDK identity hint every browser SDK sends on
				// every request; a listener that does not allow it fails preflight
				// for the whole SDK.
				"access-control-allow-headers":
					"content-type, content-encoding, authorization, x-maple-sdk, x-maple-maintenance-token",
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

/**
 * A message for a thrown value of unknown shape that is never `{}` or
 * `[object Object]`.
 *
 * `(error as Error).message` was the idiom here, and a throw that was not an
 * `Error` — or was an `Error` subclass carrying its detail elsewhere — reduced to
 * `undefined` or to an empty JSON object. Production carried 94 spans reading
 * exactly `Error: {}` at `POST /v1/traces`: the throw survived all the way to the
 * tracer, which fingerprinted it into one issue with no message, no type, and no
 * stack beyond the span name. Nothing about it could be diagnosed.
 *
 * So every branch here must yield something a human can act on, and the last
 * resort names the shape rather than pretending to describe it.
 */
export const describeThrown = (error: unknown): string => {
	if (error instanceof Error && error.message !== "") return error.message
	if (typeof error === "string" && error !== "") return error
	if (error !== null && typeof error === "object") {
		// Both reads are inside the try: `message` may be a getter that throws, and
		// reading it outside would defeat the whole point of this function.
		try {
			// `in` narrows without invoking the getter; the read below is what can
			// throw, and it is inside the try for exactly that reason.
			if ("message" in error) {
				const message = error.message
				if (typeof message === "string" && message !== "") return message
			}
			const json = JSON.stringify(error)
			// `{}` here means every own property was non-enumerable or unserializable
			// (a `Response`, a class instance) — the empty object is the bug, so say so.
			if (json !== undefined && json !== "{}") return json
		} catch {
			// Circular, or a getter that throws. Fall through to the constructor name.
		}
		return `non-serializable ${error.constructor?.name ?? "object"} thrown`
	}
	return `${typeof error} thrown: ${String(error)}`
}

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

async function ingest(
	db: Chdb,
	authority: RetiredDayAuthority,
	eventing: LocalEventingRuntime,
	signal: Signal,
	req: Request,
): Promise<IngestResult> {
	let raw: Uint8Array
	try {
		raw = new Uint8Array(await req.arrayBuffer())
	} catch (error) {
		// A client that hangs up mid-body rejects here. Unguarded, this became an
		// Effect *defect* — no `error.type`, no 4xx suppression, and a span reading
		// only "The connection was closed." It is a caller outcome, so 400 it.
		return {
			response: text(`read ${signal} body: ${describeThrown(error)}`, 400),
			accepted: 0,
			requestBytes: 0,
		}
	}
	const requestBytes = raw.length
	const contentType = req.headers.get("content-type") ?? ""
	const contentEncoding = req.headers.get("content-encoding")
	let decoded: unknown
	try {
		decoded = decodeOtlp(signal, raw, contentType, contentEncoding)
	} catch (error) {
		return {
			response: text(`decode ${signal}: ${describeThrown(error)}`, 400),
			accepted: 0,
			requestBytes,
		}
	}
	let evaluation: ReturnType<LocalEventingRuntime["evaluateOtlp"]>
	try {
		evaluation = eventing.evaluateOtlp(signal, decoded, (rangeDate) => authority.isRetired(rangeDate))
	} catch (error) {
		const status = error instanceof OtlpFieldError ? 400 : 503
		return {
			response: text(`event projection ${signal}: ${(error as Error).message}`, status),
			accepted: 0,
			requestBytes,
		}
	}
	let batches: EncodedBatch[]
	try {
		batches = encodeFor(signal, decoded)
	} catch (error) {
		// A malformed field is the sender's fault, not ours — reject the batch
		// with a 400 naming the field instead of silently storing a bad value.
		const status = error instanceof OtlpFieldError ? 400 : 500
		const stage = status === 400 ? "decode" : "encode"
		return {
			response: text(`${stage} ${signal}: ${describeThrown(error)}`, status),
			accepted: 0,
			requestBytes,
		}
	}
	let stagedEventIds: readonly string[] = []
	try {
		eventing.persistFailures(evaluation.failures)
		if (evaluation.events.length > 0) stagedEventIds = eventing.stage(evaluation.events).eventIds
	} catch (error) {
		const status = error instanceof OtlpFieldError ? 400 : 503
		return {
			response: text(`event projection ${signal}: ${(error as Error).message}`, status),
			accepted: 0,
			requestBytes,
		}
	}
	let rejected = 0
	batches = batches.map((batch) => {
		const filtered = authority.filterBatch(batch.datasource, batch.ndjson)
		rejected += filtered.rejected
		return { ...batch, ndjson: filtered.ndjson, rowCount: filtered.accepted }
	})
	let accepted = 0
	for (const batch of batches) {
		if (batch.rowCount === 0) continue
		for (const statement of buildInsertStatements(batch.datasource, batch.ndjson)) {
			try {
				db.exec(statement.sql)
			} catch (error) {
				return {
					response: text(`chDB insert (${batch.datasource}): ${describeThrown(error)}`, 500),
					accepted,
					requestBytes,
				}
			}
			accepted += statement.rowCount
		}
	}
	try {
		const readyEventIds = [...evaluation.recoveredEventIds, ...stagedEventIds]
		if (readyEventIds.length > 0) eventing.markReady(readyEventIds)
	} catch (error) {
		return {
			response: text(`event outbox readiness ${signal}: ${(error as Error).message}`, 503),
			accepted,
			requestBytes,
		}
	}
	const errorMessage = rejected > 0 ? "telemetry from permanently retired UTC days was rejected" : ""
	if (contentType.includes("json")) {
		const rejectedField =
			signal === "traces"
				? { rejectedSpans: rejected }
				: signal === "logs"
					? { rejectedLogRecords: rejected }
					: { rejectedDataPoints: rejected }
		return {
			response: json(rejected > 0 ? { partialSuccess: { ...rejectedField, errorMessage } } : {}),
			accepted,
			requestBytes,
		}
	}
	return {
		response: new Response(encodeExportResponse(signal, rejected, errorMessage), {
			status: 200,
			headers: { "content-type": "application/x-protobuf" },
		}),
		accepted,
		requestBytes,
	}
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

async function handleQuery(db: Chdb, authority: RetiredDayAuthority, req: Request): Promise<QueryResult> {
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
	const readOnly = /^\s*(?:SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN|EXISTS)\b/i.test(sql)
	if (!readOnly && authority.hasRetiredDays()) {
		return {
			response: text("local SQL writes are disabled after the first UTC day is retired", 405),
			rowCount: 0,
			durationMs: Math.round(performance.now() - started),
			sql,
		}
	}
	try {
		out = db.query(forceJsonEachRow(sql))
	} catch (error) {
		// 400, not 500: a failing statement is a problem with the submitted SQL,
		// and a 5xx would make the shared warehouse executor classify it as a
		// transient upstream error and retry the identical query.
		return {
			response: text(`query failed: ${describeThrown(error)}`, 400),
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
/** A rejection out of `ingest`, carried as a typed failure so it becomes a 500
 *  with a real message rather than an untyped defect. */
class IngestFailed extends Schema.TaggedError<IngestFailed>()("@maple/cli/IngestFailed", {
	message: Schema.String,
}) {}

class IngestRejected extends Schema.TaggedError<IngestRejected>()("@maple/cli/IngestRejected", {
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
const ingestSpan = (
	runSpan: SpanRunner,
	db: Chdb,
	authority: RetiredDayAuthority,
	eventing: LocalEventingRuntime,
	signal: Signal,
	req: Request,
): Promise<Response> =>
	runSpan(
		recoverResponse(
			Effect.gen(function* () {
				// `Effect.promise` is for promises that cannot reject, and `ingest`
				// can: it awaits the request body and drives chDB. A rejection there
				// became a DEFECT, which `recoverResponse`'s `Effect.match` does not
				// catch — so it escaped as an untyped, unlabelled span error instead of
				// the 500 the caller should have received.
				const { response, accepted, requestBytes } = yield* Effect.tryPromise({
					try: () => ingest(db, authority, eventing, signal, req),
					catch: (error): IngestFailed => new IngestFailed({ message: describeThrown(error) }),
				}).pipe(
					Effect.catchTag("@maple/cli/IngestFailed", (error) =>
						Effect.succeed({
							response: text(`ingest ${signal}: ${error.message}`, 500),
							accepted: 0,
							requestBytes: 0,
						}),
					),
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
const querySpan = (
	runSpan: SpanRunner,
	db: Chdb,
	authority: RetiredDayAuthority,
	req: Request,
): Promise<Response> =>
	runSpan(
		recoverResponse(
			Effect.gen(function* () {
				const { response, rowCount, durationMs, sql } = yield* Effect.promise(() =>
					handleQuery(db, authority, req),
				)
				yield* Effect.annotateCurrentSpan({
					"db.system.name": "clickhouse",
					"db.duration_ms": durationMs,
					"result.rowCount": rowCount,
					"http.response.status_code": response.status,
					...(sql
						? { "db.query.text": truncateSql(sql), "db.query.length": sql.length }
						: undefined),
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

/** Admission closes before retirement and reopens only after all previously
 * accepted ingest/query work has drained and the durable transition finishes. */
export class RequestQuiescenceGate {
	#active = 0
	#closed = false
	#drained: Array<() => void> = []

	enter(): (() => void) | null {
		if (this.#closed) return null
		this.#active++
		let released = false
		return () => {
			if (released) return
			released = true
			this.#active--
			if (this.#active === 0) {
				for (const resolve of this.#drained.splice(0)) resolve()
			}
		}
	}

	async exclusive<A>(work: () => Promise<A>): Promise<A> {
		if (this.#closed) throw new MaintenanceInProgressError()
		this.#closed = true
		try {
			if (this.#active > 0) await new Promise<void>((resolve) => this.#drained.push(resolve))
			return await work()
		} finally {
			this.#closed = false
		}
	}
}

class MaintenanceInProgressError extends Error {
	constructor() {
		super("another server maintenance operation is active")
		this.name = "MaintenanceInProgressError"
	}
}

class RequestBodyTooLargeError extends Error {
	constructor(readonly maximumBytes: number) {
		super(`request body exceeds ${maximumBytes} bytes`)
		this.name = "RequestBodyTooLargeError"
	}
}

const readBoundedJson = async (req: Request, maximumBytes: number): Promise<unknown> => {
	const contentLength = req.headers.get("content-length")
	if (contentLength !== null && /^[0-9]+$/.test(contentLength)) {
		const declared = Number(contentLength)
		if (!Number.isSafeInteger(declared) || declared > maximumBytes)
			throw new RequestBodyTooLargeError(maximumBytes)
	}
	if (req.body === null) return JSON.parse("") as unknown
	const reader = req.body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			total += value.byteLength
			if (total > maximumBytes) {
				await reader.cancel()
				throw new RequestBodyTooLargeError(maximumBytes)
			}
			chunks.push(value)
		}
	} finally {
		reader.releaseLock()
	}
	const bytes = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

const invalidJsonResponse = (error: unknown): Response =>
	error instanceof RequestBodyTooLargeError ? text(error.message, 413) : text("invalid JSON body", 400)

const admitted = async (gate: RequestQuiescenceGate, work: () => Promise<Response>): Promise<Response> => {
	const leave = gate.enter()
	if (!leave) return text("server maintenance in progress", 503)
	try {
		return await work()
	} finally {
		leave()
	}
}

const handleRetirement = async (
	db: Chdb,
	authority: RetiredDayAuthority,
	gate: RequestQuiescenceGate,
	token: string,
	req: Request,
): Promise<Response> => {
	if (!maintenanceTokenMatches(token, req.headers.get("x-maple-maintenance-token")))
		return text("maintenance authorization required", 403)
	let body: unknown
	try {
		body = await req.json()
	} catch {
		return text("invalid JSON body", 400)
	}
	if (!Predicate.isObject(body)) return text("invalid body", 400)
	const record = body
	const keys = Object.keys(record).sort().join(",")
	if (keys !== "archiveDir,rangeDate,sealingLagHours") return text("invalid retirement fields", 400)
	if (
		typeof record.archiveDir !== "string" ||
		typeof record.rangeDate !== "string" ||
		typeof record.sealingLagHours !== "number"
	)
		return text("invalid retirement values", 400)
	try {
		const retired = await gate.exclusive(() =>
			retireLiveDayInServer({
				db,
				authority,
				archiveDir: record.archiveDir as string,
				rangeDate: record.rangeDate as string,
				sealingLagHours: record.sealingLagHours as number,
			}),
		)
		return json(retired)
	} catch (error) {
		return text(`retirement failed: ${error instanceof Error ? error.message : String(error)}`, 409)
	}
}

const CHECKPOINT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_CHECKPOINT_BODY_BYTES = 4 * 1024
const MAX_PROJECTION_BODY_BYTES = 512 * 1024
const MAX_CONSUMER_BODY_BYTES = 16 * 1024

/** Typed, authenticated replacement for sending BACKUP through /local/query. */
const handleCheckpointBackup = async (
	db: Chdb,
	controlStore: LocalEventingControlStore,
	dataDir: string,
	gate: RequestQuiescenceGate,
	token: string,
	req: Request,
): Promise<Response> => {
	if (!maintenanceTokenMatches(token, req.headers.get("x-maple-maintenance-token")))
		return text("maintenance authorization required", 403)
	let body: unknown
	try {
		body = await readBoundedJson(req, MAX_CHECKPOINT_BODY_BYTES)
	} catch (error) {
		return invalidJsonResponse(error)
	}
	if (!Predicate.isObject(body)) return text("invalid body", 400)
	const record = body
	if (Object.keys(record).sort().join(",") !== "checkpointId" || !Predicate.isString(record.checkpointId))
		return text("invalid checkpoint fields", 400)
	if (!CHECKPOINT_ID.test(record.checkpointId)) return text("invalid checkpoint ID", 400)
	try {
		const checkpointId = record.checkpointId.toLowerCase()
		return await gate.exclusive(async () => {
			const control = await controlStore.backupTo(eventingControlSnapshotPath(dataDir, checkpointId))
			db.exec(`BACKUP DATABASE default TO Disk('default', 'backups/snapshots/${checkpointId}/backup')`)
			return json({ checkpointId, control })
		})
	} catch (error) {
		if (error instanceof MaintenanceInProgressError) return text(error.message, 409)
		return text(
			`checkpoint backup failed: ${error instanceof Error ? error.message : String(error)}`,
			400,
		)
	}
}

const eventingAuthorized = (token: string, req: Request): Response | null =>
	maintenanceTokenMatches(token, req.headers.get("x-maple-maintenance-token"))
		? null
		: text("maintenance authorization required", 403)

const handleProjectionActivation = async (
	eventing: LocalEventingRuntime,
	gate: RequestQuiescenceGate,
	token: string,
	req: Request,
): Promise<Response> => {
	const unauthorized = eventingAuthorized(token, req)
	if (unauthorized) return unauthorized
	let body: unknown
	try {
		body = await readBoundedJson(req, MAX_PROJECTION_BODY_BYTES)
	} catch (error) {
		return invalidJsonResponse(error)
	}
	let activation
	try {
		// Recursive schema validation and full registry compilation happen while
		// normal ingest/query admission remains open.
		activation = eventing.prepareActivation(body)
	} catch (error) {
		return text(
			`invalid event projection: ${error instanceof Error ? error.message : String(error)}`,
			400,
		)
	}
	try {
		await gate.exclusive(async () => eventing.commitActivation(activation))
		return json({ active: eventing.listActive() })
	} catch (error) {
		if (error instanceof MaintenanceInProgressError) return text(error.message, 409)
		return text(
			`invalid event projection: ${error instanceof Error ? error.message : String(error)}`,
			400,
		)
	}
}

const eventConsumerErrorResponse = (error: unknown): Response => {
	const message = error instanceof Error ? error.message : String(error)
	if (error instanceof EventConsumerNotFoundError) return text(message, 404)
	if (error instanceof EventConsumerConflictError) return text(message, 409)
	if (error instanceof EventConsumerInputError) return text(message, 400)
	return text(`event consumer operation failed: ${message}`, 500)
}

const isRequestRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const handleConsumerRegistration = async (
	eventing: LocalEventingRuntime,
	gate: RequestQuiescenceGate,
	maintenanceToken: string,
	req: Request,
): Promise<Response> => {
	const unauthorized = eventingAuthorized(maintenanceToken, req)
	if (unauthorized) return unauthorized
	let body: unknown
	try {
		body = await readBoundedJson(req, MAX_CONSUMER_BODY_BYTES)
	} catch (error) {
		return invalidJsonResponse(error)
	}
	if (!isRequestRecord(body)) return text("invalid body", 400)
	const record = body
	const consumerId = record.consumerId
	const startAt = record.startAt
	if (
		Object.keys(record).sort().join(",") !== "consumerId,startAt" ||
		!Schema.is(Schema.String)(consumerId) ||
		(startAt !== "beginning" && startAt !== "latest")
	)
		return text("invalid event consumer registration fields", 400)
	return admitted(gate, async () => {
		try {
			return json(eventing.registerConsumer(consumerId, startAt), 201)
		} catch (error) {
			return eventConsumerErrorResponse(error)
		}
	})
}

const handleConsumerDisable = async (
	eventing: LocalEventingRuntime,
	gate: RequestQuiescenceGate,
	maintenanceToken: string,
	req: Request,
): Promise<Response> => {
	const unauthorized = eventingAuthorized(maintenanceToken, req)
	if (unauthorized) return unauthorized
	let body: unknown
	try {
		body = await readBoundedJson(req, MAX_CONSUMER_BODY_BYTES)
	} catch (error) {
		return invalidJsonResponse(error)
	}
	if (!isRequestRecord(body)) return text("invalid body", 400)
	const record = body
	const consumerId = record.consumerId
	if (Object.keys(record).join(",") !== "consumerId" || !Schema.is(Schema.String)(consumerId))
		return text("invalid event consumer disable fields", 400)
	return admitted(gate, async () => {
		try {
			return json(eventing.disableConsumer(consumerId))
		} catch (error) {
			return eventConsumerErrorResponse(error)
		}
	})
}

const handleConsumerClaim = async (
	eventing: LocalEventingRuntime,
	gate: RequestQuiescenceGate,
	consumerToken: string,
	req: Request,
): Promise<Response> => {
	if (!eventConsumerTokenMatches(consumerToken, req.headers.get("x-maple-event-consumer-token")))
		return text("event consumer authorization required", 403)
	let body: unknown
	try {
		body = await readBoundedJson(req, MAX_CONSUMER_BODY_BYTES)
	} catch (error) {
		return invalidJsonResponse(error)
	}
	if (!isRequestRecord(body)) return text("invalid body", 400)
	const record = body
	const consumerId = record.consumerId
	const limit = record.limit
	const leaseSeconds = record.leaseSeconds
	if (
		Object.keys(record).sort().join(",") !== "consumerId,leaseSeconds,limit" ||
		!Schema.is(Schema.String)(consumerId) ||
		!Schema.is(Schema.Number)(limit) ||
		!Schema.is(Schema.Number)(leaseSeconds)
	)
		return text("invalid event consumer claim fields", 400)
	return admitted(gate, async () => {
		try {
			return json(eventing.claimReady(consumerId, limit, leaseSeconds))
		} catch (error) {
			return eventConsumerErrorResponse(error)
		}
	})
}

const handleConsumerAcknowledgement = async (
	eventing: LocalEventingRuntime,
	gate: RequestQuiescenceGate,
	consumerToken: string,
	req: Request,
): Promise<Response> => {
	if (!eventConsumerTokenMatches(consumerToken, req.headers.get("x-maple-event-consumer-token")))
		return text("event consumer authorization required", 403)
	let body: unknown
	try {
		body = await readBoundedJson(req, MAX_CONSUMER_BODY_BYTES)
	} catch (error) {
		return invalidJsonResponse(error)
	}
	if (!isRequestRecord(body)) return text("invalid body", 400)
	const record = body
	const consumerId = record.consumerId
	const leaseToken = record.leaseToken
	const throughSequence = record.throughSequence
	if (
		Object.keys(record).sort().join(",") !== "consumerId,leaseToken,throughSequence" ||
		!Schema.is(Schema.String)(consumerId) ||
		!Schema.is(Schema.String)(leaseToken) ||
		!Schema.is(Schema.Number)(throughSequence)
	)
		return text("invalid event consumer acknowledgement fields", 400)
	return admitted(gate, async () => {
		try {
			return json(eventing.acknowledgeClaim(consumerId, leaseToken, throughSequence))
		} catch (error) {
			return eventConsumerErrorResponse(error)
		}
	})
}

const handleEventingRead = (
	eventing: LocalEventingRuntime,
	token: string,
	req: Request,
	url: URL,
): Response => {
	const unauthorized = eventingAuthorized(token, req)
	if (unauthorized) return unauthorized
	if (url.pathname === "/local/eventing/health") return json(eventing.health())
	if (url.pathname === "/local/eventing/projections") return json(eventing.listActive())
	if (url.pathname === "/local/eventing/consumers") return json(eventing.listConsumers())
	if (url.pathname === "/local/eventing/outbox") {
		const rawLimit = url.searchParams.get("limit")
		const limit = rawLimit === null ? 100 : Number(rawLimit)
		const rawAfter = url.searchParams.get("after")
		const after = rawAfter === null ? 0 : Number(rawAfter)
		const state = url.searchParams.get("state") ?? "ready"
		try {
			if (state === "ready") return json(eventing.listReady(limit, after))
			if (state === "staged") return json(eventing.listStaged(limit, after))
			return text("outbox state must be ready or staged", 400)
		} catch (error) {
			return text(error instanceof Error ? error.message : String(error), 400)
		}
	}
	return text("not found", 404)
}

/** The `Bun.serve` fetch handler, closed over the chDB connection. Each ingest
 *  and query request is run through `runSpan` so it leaves a trace; `/health`
 *  and `OPTIONS` are skipped (loop-prevention convention — no health-check noise). */
const makeFetch =
	(
		db: Chdb,
		options: ServerOptions,
		runSpan: SpanRunner,
		authority: RetiredDayAuthority,
		gate: RequestQuiescenceGate,
		maintenanceToken: string,
		consumerToken: string,
		controlStore: LocalEventingControlStore,
		eventing: LocalEventingRuntime,
	) =>
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
			if (url.pathname === "/v1/traces")
				return respond(
					await admitted(gate, () => ingestSpan(runSpan, db, authority, eventing, "traces", req)),
				)
			if (url.pathname === "/v1/logs")
				return respond(
					await admitted(gate, () => ingestSpan(runSpan, db, authority, eventing, "logs", req)),
				)
			if (url.pathname === "/v1/metrics")
				return respond(
					await admitted(gate, () => ingestSpan(runSpan, db, authority, eventing, "metrics", req)),
				)
			if (url.pathname === "/local/query")
				return respond(await admitted(gate, () => querySpan(runSpan, db, authority, req)))
			if (url.pathname === "/local/checkpoint/backup")
				return respond(
					await handleCheckpointBackup(
						db,
						controlStore,
						options.dataDir,
						gate,
						maintenanceToken,
						req,
					),
				)
			if (url.pathname === "/local/eventing/projections")
				return respond(await handleProjectionActivation(eventing, gate, maintenanceToken, req))
			if (url.pathname === "/local/eventing/consumers")
				return respond(await handleConsumerRegistration(eventing, gate, maintenanceToken, req))
			if (url.pathname === "/local/eventing/consumers/disable")
				return respond(await handleConsumerDisable(eventing, gate, maintenanceToken, req))
			if (url.pathname === "/local/eventing/claims")
				return respond(await handleConsumerClaim(eventing, gate, consumerToken, req))
			if (url.pathname === "/local/eventing/acks")
				return respond(await handleConsumerAcknowledgement(eventing, gate, consumerToken, req))
			if (url.pathname === "/local/retention/retire")
				return respond(await handleRetirement(db, authority, gate, maintenanceToken, req))
		}
		if (req.method === "GET" && url.pathname.startsWith("/local/eventing/"))
			return respond(handleEventingRead(eventing, maintenanceToken, req, url))
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
		const retention = yield* Effect.try({
			try: () => {
				const existing = readRawTelemetryRetentionDays(options.dataDir)
				const requested = options.minimumRawTelemetryRetentionDays
				if (requested !== undefined) rawTelemetryTtlStatements(requested)
				if (existing !== undefined && requested !== undefined && requested < existing)
					throw new Error(
						`refusing to shorten persistent raw telemetry retention from ${existing} to ${requested} days`,
					)
				return { existing, requested, effective: requested ?? existing }
			},
			catch: (error) =>
				new ChdbError({
					message: `failed to load persistent raw telemetry retention: ${error instanceof Error ? error.message : String(error)}`,
				}),
		})
		const db = yield* acquireChdb({
			dataDir: options.dataDir,
			schemaSql: LOCAL_SCHEMA_SQL,
			configFile: options.configFile,
			rawTelemetryRetentionDays: retention.effective,
		})
		// The request handler and synchronous eventing store share one telemetry
		// runtime; eventing observations contain only bounded operation labels.
		const telemetry = yield* Effect.acquireRelease(
			Effect.sync(() => ManagedRuntime.make(TelemetryLayer)),
			(rt) => Effect.promise(() => rt.dispose()),
		)
		const eventingTelemetry = makeEffectEventingTelemetry((effect) => {
			telemetry.runFork(effect)
		})
		const controlStore = yield* Effect.acquireRelease(
			Effect.tryPromise({
				try: () => LocalEventingControlStore.open(options.dataDir, undefined, eventingTelemetry),
				catch: (error) =>
					new ChdbError({
						message: `failed to open local eventing control store: ${error instanceof Error ? error.message : String(error)}`,
					}),
			}),
			(store) => Effect.sync(() => store.close()),
		)
		const eventing = yield* Effect.try({
			try: () => new LocalEventingRuntime(controlStore, eventingTelemetry),
			catch: (error) =>
				new ChdbError({
					message: `failed to compile local event projections: ${error instanceof Error ? error.message : String(error)}`,
				}),
		})
		// `CREATE ... IF NOT EXISTS` does not repair a table whose physical
		// definition was altered out of band. Inspect the opened store before the
		// listener is bound; a mismatch fails startup rather than allowing new
		// query code to run against a partially old layout.
		yield* Effect.try({
			try: () => assertCurrentPhysicalSchema(db, retention.effective),
			catch: (error) =>
				new ChdbError({
					message: `local physical-schema verification failed: ${error instanceof Error ? error.message : String(error)}`,
				}),
		})
		yield* Effect.tryPromise({
			try: () =>
				ensureStoreMarkerDurable(
					options.dataDir,
					{
						version: CURRENT_LOCAL_SCHEMA.version,
						digest: CURRENT_LOCAL_SCHEMA.digest,
						fingerprint: SCHEMA_FINGERPRINT,
					},
					MAPLE_VERSION,
				),
			catch: (error) =>
				new ChdbError({
					message: `could not durably record local-store identity: ${error instanceof Error ? error.message : String(error)}`,
				}),
		})
		// The ALTER statements have now been accepted by the running database.
		// Only after that validation succeeds does a requested value become the
		// durable configuration used by subsequent launches.
		if (retention.requested !== undefined)
			yield* Effect.tryPromise({
				try: () => configureRawTelemetryRetentionDays(options.dataDir, retention.requested!),
				catch: (error) =>
					new ChdbError({
						message: `failed to persist raw telemetry retention: ${error instanceof Error ? error.message : String(error)}`,
					}),
			})
		const authority = yield* Effect.try({
			try: () => {
				const loaded = new RetiredDayAuthority(options.dataDir)
				// Checkpoint restore may have resurrected retired rows. Replay before
				// the listener is bound, so no restored representation is observable.
				loaded.replay(db)
				return loaded
			},
			catch: (error) =>
				new ChdbError({
					message: `failed to enforce retired-day authority: ${error instanceof Error ? error.message : String(error)}`,
				}),
		})
		const maintenanceToken = yield* Effect.tryPromise({
			try: () => ensureMaintenanceToken(options.dataDir),
			catch: (error) =>
				new ChdbError({
					message: `failed to load maintenance token: ${error instanceof Error ? error.message : String(error)}`,
				}),
		})
		const consumerToken = yield* Effect.tryPromise({
			try: () => ensureEventConsumerToken(options.dataDir),
			catch: (error) =>
				new ChdbError({
					message: `failed to load event consumer token: ${error instanceof Error ? error.message : String(error)}`,
				}),
		})
		const gate = new RequestQuiescenceGate()
		const runSpan: SpanRunner = (effect) => telemetry.runPromise(effect)
		const server = yield* Effect.acquireRelease(
			Effect.try({
				try: () =>
					Bun.serve({
						port: options.port,
						hostname: options.hostname,
						fetch: makeFetch(
							db,
							options,
							runSpan,
							authority,
							gate,
							maintenanceToken,
							consumerToken,
							controlStore,
							eventing,
						),
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

export const __testables = {
	handleConsumerAcknowledgement,
	handleConsumerClaim,
	handleConsumerDisable,
	handleConsumerRegistration,
	handleCheckpointBackup,
	handleEventingRead,
	handleProjectionActivation,
	ingest,
	readBoundedJson,
	recordServerResponse,
	RequestQuiescenceGate,
}
