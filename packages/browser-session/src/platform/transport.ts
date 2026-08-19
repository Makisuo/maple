/**
 * The slice of configuration the replay engine needs. Both SDKs adapt their
 * own config shapes onto this.
 */
export interface IngestConfig {
	readonly endpoint: string
	readonly ingestKey: string
	/** `x-maple-sdk` value — see {@link SDK_HINT_HEADER}. */
	readonly sdk: string
	readonly maskAllInputs: boolean
	readonly maskAllText: boolean
}

/**
 * Header stamped on every request to ingest: `<sdk-name>/<version>`, e.g.
 * `maple-browser/0.3.0`. Browsers refuse to let a page set `user-agent`, so
 * without this a rejected request carried nothing that said which SDK build
 * produced it. Ingest records it as `maple.sdk` on the request span. Every
 * gateway that receives browser traffic must allow it in CORS (`apps/ingest`
 * and the CLI's local listener do) — a header the SDK always sends and
 * preflight refuses blocks the whole SDK, not just the header.
 */
export const SDK_HINT_HEADER = "x-maple-sdk"

/** `<name>/<version>` — the one shape ingest expects in `x-maple-sdk`. */
export const sdkHint = (name: string, version: string): string => `${name}/${version}`

/** Auth + identity headers shared by every ingest request. */
export function ingestHeaders(config: Pick<IngestConfig, "ingestKey" | "sdk">): Record<string, string> {
	return {
		Authorization: `Bearer ${config.ingestKey}`,
		[SDK_HINT_HEADER]: config.sdk,
	}
}

// Replay POSTs are best-effort and must never throw into the host app, but a
// fully broken ingest endpoint should not be *silent*. Warn at most once every
// 30s so a misconfigured endpoint is visible in the console without spamming it.
// Rate-limited per call site, so a broken endpoint surfaces each distinct
// failure rather than whichever one happened to warn first.
const lastWarnAt = new Map<string, number>()
function warnDropped(what: string, error: unknown): void {
	const now = Date.now()
	if (now - (lastWarnAt.get(what) ?? 0) < 30_000) return
	lastWarnAt.set(what, now)
	console.warn(`[maple] session replay ${what} failed (dropping; will retry on next chunk):`, error)
}

/**
 * Largest body we will hand to a `keepalive` fetch.
 *
 * The Fetch spec caps the *combined* inflight keepalive body at 64 KiB, and on
 * the way out we issue up to three of these at once (metadata row, final events
 * batch, last replay chunk). Over the budget the browser rejects the request
 * outright, so a normal request — which the page may or may not survive long
 * enough to finish — is strictly the better bet than a guaranteed rejection.
 */
const MAX_KEEPALIVE_BYTES = 48 * 1024

/** Whether a body of `bytes` may still ride the keepalive budget. */
export function keepaliveFor(requested: boolean, bytes: number): boolean {
	return requested && bytes <= MAX_KEEPALIVE_BYTES
}

/** gzip a byte buffer using the native CompressionStream (no library). */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new CompressionStream("gzip")
	const writer = stream.writable.getWriter()
	void writer.write(bytes as BufferSource)
	void writer.close()
	const buffer = await new Response(stream.readable).arrayBuffer()
	return new Uint8Array(buffer)
}

/** POST session metadata (NDJSON, single row). `keepalive` for the final unload write. */
export async function postSessionMeta(
	config: IngestConfig,
	row: Record<string, unknown>,
	keepalive = false,
): Promise<void> {
	const body = `${JSON.stringify(row)}\n`
	await fetch(`${config.endpoint}/v1/sessionReplays/meta`, {
		method: "POST",
		headers: {
			...ingestHeaders(config),
			"content-type": "application/x-ndjson",
		},
		body,
		keepalive: keepaliveFor(keepalive, body.length),
	}).catch((error) => {
		// Replay is best-effort; never throw into the host app.
		warnDropped("metadata POST", error)
	})
}

/** POST distilled session events (NDJSON, one row per event). Best-effort. */
export async function postSessionEvents(
	config: IngestConfig,
	rows: ReadonlyArray<Record<string, unknown>>,
	keepalive = false,
): Promise<void> {
	if (rows.length === 0) return
	const body = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
	await fetch(`${config.endpoint}/v1/sessionEvents`, {
		method: "POST",
		headers: {
			...ingestHeaders(config),
			"content-type": "application/x-ndjson",
		},
		body,
		keepalive: keepaliveFor(keepalive, body.length),
	}).catch((error) => {
		warnDropped("events POST", error)
	})
}

export interface ChunkMeta {
	readonly sessionId: string
	readonly chunkSeq: number
	readonly isCheckpoint: boolean
	readonly eventCount: number
	readonly durationMs: number
}

/**
 * How ingest answered a chunk upload. `"exhausted"` is the 413 ingest returns
 * once a session has hit its recorded-size ceiling; every later chunk of that
 * session gets the same answer, so the recorder must stop uploading rather than
 * pay for a rejected POST every flush for the rest of the page's life.
 */
export type BlobPostOutcome = "accepted" | "rejected" | "exhausted" | "failed"

const SESSION_EXHAUSTED_STATUS = 413

/** POST a gzipped rrweb event chunk. */
export async function postSessionBlob(
	config: IngestConfig,
	meta: ChunkMeta,
	gzipped: Uint8Array,
	keepalive = false,
): Promise<BlobPostOutcome> {
	try {
		const response = await fetch(`${config.endpoint}/v1/sessionReplays/blob`, {
			method: "POST",
			headers: {
				...ingestHeaders(config),
				"content-type": "application/octet-stream",
				"x-maple-session-id": meta.sessionId,
				"x-maple-chunk-seq": String(meta.chunkSeq),
				"x-maple-is-checkpoint": meta.isCheckpoint ? "1" : "0",
				"x-maple-event-count": String(meta.eventCount),
				"x-maple-duration-ms": String(meta.durationMs),
			},
			body: gzipped as BodyInit,
			keepalive: keepaliveFor(keepalive, gzipped.byteLength),
		})
		if (response.ok) return "accepted"
		return response.status === SESSION_EXHAUSTED_STATUS ? "exhausted" : "rejected"
	} catch (error) {
		// Best-effort.
		warnDropped("blob PUT", error)
		return "failed"
	}
}
