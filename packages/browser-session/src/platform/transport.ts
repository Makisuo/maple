/**
 * The slice of configuration the replay engine needs. Both SDKs adapt their
 * own config shapes onto this.
 */
export interface IngestConfig {
	readonly endpoint: string
	readonly ingestKey: string
	readonly maskAllInputs: boolean
	readonly maskAllText: boolean
	/**
	 * Identity from `identify()`, consulted when session-event rows are built so
	 * a late `identify()` still stamps `user_id`/`group_id` on the rows that
	 * follow it — the same source the session metadata row reads.
	 */
	readonly getIdentity?: (() => EventIdentity | undefined) | undefined
}

/**
 * The slice of `ResolvedIdentity` that rides on session-event rows. Declared
 * structurally so this transport layer stays free of the identity module.
 */
export interface EventIdentity {
	readonly id?: string | undefined
	readonly groupId?: string | undefined
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
			Authorization: `Bearer ${config.ingestKey}`,
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
			Authorization: `Bearer ${config.ingestKey}`,
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

/** POST a gzipped rrweb event chunk. */
export async function postSessionBlob(
	config: IngestConfig,
	meta: ChunkMeta,
	gzipped: Uint8Array,
	keepalive = false,
): Promise<void> {
	await fetch(`${config.endpoint}/v1/sessionReplays/blob`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${config.ingestKey}`,
			"content-type": "application/octet-stream",
			"x-maple-session-id": meta.sessionId,
			"x-maple-chunk-seq": String(meta.chunkSeq),
			"x-maple-is-checkpoint": meta.isCheckpoint ? "1" : "0",
			"x-maple-event-count": String(meta.eventCount),
			"x-maple-duration-ms": String(meta.durationMs),
		},
		body: gzipped as BodyInit,
		keepalive: keepaliveFor(keepalive, gzipped.byteLength),
	}).catch((error) => {
		// Best-effort.
		warnDropped("blob PUT", error)
	})
}
