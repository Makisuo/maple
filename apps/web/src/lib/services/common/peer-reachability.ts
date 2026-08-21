/**
 * Whether the browser can currently reach a given origin.
 *
 * A rejection with no response at all — `TypeError: Failed to fetch`, an Effect
 * `TransportError` — says the connection died, not that the application did. In
 * a dashboard holding several Electric long-polls open around the clock, that
 * happens on every wifi blip, VPN reconnect and laptop wake: at 16:55:39 on one
 * production session, four shape long-polls and every in-flight API call failed
 * inside two seconds while the *server* spans for those same requests completed
 * `Ok` at 40s, and the session went on for another 14 minutes. Nothing failed;
 * the browser stopped being able to reach anything. Reporting each one is what
 * left maple-web at a 15% error rate and fired a critical High error rate alert.
 *
 * A blip and an outage differ in how long they last, not in what they throw, so
 * that is what this measures. The first failure starts the clock, any response
 * at all (a 500 included — the peer answered) stops it, and only failures still
 * arriving after the grace window are treated as real. So a real outage — an
 * unreachable API, a CORS misconfiguration, a bad base URL — still reports,
 * continuously and from 15s in, while a blip reports nothing.
 *
 * Elapsed time, not a failure count: a blip fails every concurrent request at
 * once, so counting would escalate on the first one.
 *
 * Keyed by origin, not by caller-facing peer name, because reachability is a
 * property of the host: one clock covers the ShapeStream long-polls and the API
 * calls that die in the same instant.
 */

export const PEER_OUTAGE_GRACE_MS = 15_000

/** When each origin's current run of transport failures began. */
const unreachableSince = new Map<string, number>()

/** The origin of `url`, or the whole string when it does not parse as one. */
export const originOf = (url: string): string => {
	try {
		return new URL(url, typeof location === "undefined" ? undefined : location.href).origin
	} catch {
		return url
	}
}

/**
 * Record a transport failure and answer how long the origin has been
 * continuously unreachable — `0` for the failure that starts the run.
 */
export const noteUnreachable = (origin: string, now: number): number => {
	const since = unreachableSince.get(origin)
	if (since === undefined) {
		unreachableSince.set(origin, now)
		return 0
	}
	return now - since
}

/** The origin answered, so whatever run of failures preceded it is over. */
export const noteReachable = (origin: string): void => {
	unreachableSince.delete(origin)
}

/**
 * True while `origin` is inside a failure run that is still short enough to be a
 * blip. Read-only — for a caller that holds a failure and needs to know whether
 * to blame the network, without itself being new evidence.
 */
export const isBlipping = (origin: string, now: number): boolean => {
	const since = unreachableSince.get(origin)
	return since !== undefined && now - since < PEER_OUTAGE_GRACE_MS
}
