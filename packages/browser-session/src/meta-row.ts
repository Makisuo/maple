import type { ResolvedIdentity } from "./identity"
import type { EntryContext } from "./session"
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
	readonly clickCount?: number | undefined
	/** Navigations observed. `<= 1` on an ended session is a bounce. */
	readonly pageViews?: number | undefined
	/**
	 * Errors observed. Drives the Sessions UI "has errors" filter, which tests
	 * `ErrorCount > 0`.
	 */
	readonly errorCount?: number | undefined
	/** Persistent per-browser id; `uniq()` of it is unique visitors. */
	readonly visitorId?: string | undefined
	/** Whether that id was minted on this page load (new vs returning). */
	readonly visitorIsNew?: boolean | undefined
	/**
	 * Whether the visitor id survives the page load. `false` (storage blocked)
	 * is surfaced as a resource attribute so the analytics layer can flag
	 * inflated unique counts instead of quietly reporting them.
	 */
	readonly visitorIdPersisted?: boolean | undefined
	/** Identity from `identify()`. Supersedes `userId`. */
	readonly identity?: ResolvedIdentity | undefined
	/** Acquisition context captured at session start. */
	readonly entry?: EntryContext | undefined
	/** Most recent URL — becomes `exit_path`. */
	readonly lastUrl?: string | undefined
	/** Whether the host app allows the email through to the warehouse. */
	readonly captureUserEmail?: boolean | undefined
	/** Trace ids observed during the session — attached to `ended` rows. */
	readonly traceIds?: ReadonlyArray<string> | undefined
	/**
	 * Whether an rrweb recording accompanies this session. `false` when replay is
	 * off or unsampled, so the UI can label the session "Not recorded" instead of
	 * rendering a player with nothing to play.
	 */
	readonly recorded: boolean
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
	const location = g["window"]?.location
	const identity = input.identity
	const entryUrl = input.entry?.entryUrl ?? location?.href ?? ""
	const referrer = input.entry?.referrer ?? ""
	const utm = input.entry?.utm ?? {}

	const row: Record<string, unknown> = {
		session_id: input.sessionId,
		start_time: formatCHDateTime(input.startedAt),
		status: input.status,
		version: input.version,
		user_id: identity?.id ?? input.userId ?? "",
		url_initial: location?.href ?? "",
		user_agent: userAgent,
		browser_name: ua.browserName,
		os_name: ua.osName,
		device_type: ua.deviceType,
		service_name: input.serviceName,
		resource_attributes: {
			// Does this session have a replay to play back? Read by the Sessions UI
			// to distinguish a metadata-only session from one still uploading chunks.
			// `maple.*` vendor namespace, per the telemetry conventions.
			"maple.session.recorded": input.recorded ? "true" : "false",
			// Storage-blocked visitors get an in-memory id, so their sessions each
			// look like a distinct visitor. Flag it rather than inflate silently.
			...(input.visitorId && input.visitorIdPersisted === false
				? { "maple.visitor.persisted": "false" }
				: {}),
			...(input.environment
				? {
						// Dual-emit: legacy key (pre-extracted by Tinybird MVs) + canonical.
						"deployment.environment": input.environment,
						"deployment.environment.name": input.environment,
					}
				: {}),
			...(input.serviceVersion ? { "deployment.commit_sha": input.serviceVersion } : {}),
		},

		// Everything below is on the base row on purpose.
		//
		// The backend table is a ReplacingMergeTree that replaces the *whole* row
		// at the latest Version — it does not merge fields. Anything emitted only
		// on the active row would be wiped out by the ended row, and anything
		// emitted only on the ended row is missing for every session whose tab was
		// killed without an unload beacon. That second case is also why the
		// counters moved out of the `ended` branch: they used to default to 0 on
		// the surviving row, which read as "one page, no clicks" — a bounce.
		visitor_id: input.visitorId ?? "",
		visitor_is_new: input.visitorIsNew ? 1 : 0,
		user_email: (input.captureUserEmail === false ? undefined : identity?.email) ?? "",
		user_name: identity?.username ?? "",
		group_id: identity?.groupId ?? "",
		group_name: identity?.groupName ?? "",
		user_traits: identity?.traits ?? {},
		referrer,
		// referrer_host is derived at the gateway (one normalization for every SDK
		// version in the wild), so it is deliberately not sent from here.
		utm_source: utm.utm_source ?? "",
		utm_medium: utm.utm_medium ?? "",
		utm_campaign: utm.utm_campaign ?? "",
		utm_term: utm.utm_term ?? "",
		utm_content: utm.utm_content ?? "",
		host: location?.host ?? "",
		entry_path: pathOf(entryUrl),
		exit_path: pathOf(input.lastUrl ?? location?.href ?? ""),
		language: g["navigator"]?.language ?? "",
		last_activity_at: formatCHDateTime(now),
		click_count: input.clickCount ?? 0,
		page_views: input.pageViews ?? 0,
		error_count: input.errorCount ?? 0,
	}

	if (input.status === "ended") {
		row.end_time = formatCHDateTime(now)
		row.duration_ms = Math.max(0, now.getTime() - input.startedAt.getTime())
		row.trace_ids = input.traceIds ? Array.from(input.traceIds) : []
	}
	return row
}

/**
 * Pathname of a URL, without query string or hash.
 *
 * Query strings are the most common accidental PII carrier (`?email=`,
 * `?token=`), and paths are the analytics dimension — nobody groups by
 * `/pricing?ref=twitter` separately from `/pricing`.
 */
function pathOf(url: string): string {
	if (!url) return ""
	try {
		return new URL(url).pathname
	} catch {
		return ""
	}
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
