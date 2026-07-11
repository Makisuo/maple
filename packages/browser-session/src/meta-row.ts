import { parseUserAgent } from "./user-agent"

/** ClickHouse-style `YYYY-MM-DD HH:MM:SS.mmm` in UTC (matches the ingest gateway). */
export function formatCHDateTime(date: Date): string {
	const pad = (n: number, width = 2) => String(n).padStart(width, "0")
	return (
		`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
		`${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.` +
		`${pad(date.getUTCMilliseconds(), 3)}`
	)
}

export interface SessionMetaRowInput {
	readonly sessionId: string
	/** Session start (from the persisted record, not this page load). */
	readonly startedAt: Date
	/** Monotonic row version — take it from `nextMetaVersion()`. */
	readonly version: number
	readonly status: "active" | "ended"
	readonly serviceName: string
	readonly userId?: string | undefined
	readonly environment?: string | undefined
	readonly serviceVersion?: string | undefined
	/** Only meaningful on `ended` rows; defaults to 0. */
	readonly clickCount?: number | undefined
	/** Trace ids observed during the session — attached to `ended` rows. */
	readonly traceIds?: ReadonlyArray<string> | undefined
}

/**
 * Build one `/v1/sessionReplays/meta` NDJSON row. Shared by `@maple-dev/browser`
 * and the Effect client SDK so a session looks identical no matter which SDK
 * posted it. UA/URL facets come from the live browser globals; absent (tests,
 * exotic embedders) they fall back to empty strings.
 */
export function buildSessionMetaRow(input: SessionMetaRowInput): Record<string, unknown> {
	const g = globalThis as Record<string, any>
	const userAgent: string = g["navigator"]?.userAgent ?? ""
	const ua = parseUserAgent(userAgent)
	const now = new Date()
	const row: Record<string, unknown> = {
		session_id: input.sessionId,
		start_time: formatCHDateTime(input.startedAt),
		status: input.status,
		version: input.version,
		user_id: input.userId ?? "",
		url_initial: g["window"]?.location?.href ?? "",
		user_agent: userAgent,
		browser_name: ua.browserName,
		os_name: ua.osName,
		device_type: ua.deviceType,
		service_name: input.serviceName,
		resource_attributes: {
			...(input.environment
				? {
						// Dual-emit: legacy key (pre-extracted by Tinybird MVs) + canonical.
						"deployment.environment": input.environment,
						"deployment.environment.name": input.environment,
					}
				: {}),
			...(input.serviceVersion ? { "deployment.commit_sha": input.serviceVersion } : {}),
		},
	}
	if (input.status === "ended") {
		row.end_time = formatCHDateTime(now)
		row.duration_ms = Math.max(0, now.getTime() - input.startedAt.getTime())
		row.click_count = input.clickCount ?? 0
		row.trace_ids = input.traceIds ? Array.from(input.traceIds) : []
	}
	return row
}

/** POST one session metadata row (NDJSON). Best-effort — never throws. */
export async function postSessionMetaRow(
	endpoint: string,
	ingestKey: string,
	row: Record<string, unknown>,
	keepalive = false,
): Promise<void> {
	await fetch(`${endpoint.replace(/\/$/, "")}/v1/sessionReplays/meta`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${ingestKey}`,
			"content-type": "application/x-ndjson",
		},
		body: `${JSON.stringify(row)}\n`,
		keepalive,
	}).catch(() => {
		// Session metadata is best-effort; never throw into the host app.
	})
}
