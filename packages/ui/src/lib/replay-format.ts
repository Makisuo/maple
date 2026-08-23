// Shared presentation helpers for the session-replay surfaces (list, detail,
// player, timeline) — used by both the web app and the local-mode UI so the
// two can't drift. Warehouse-coupled helpers (partition windows) stay in the
// web app: this package doesn't depend on @maple/query-engine.

/**
 * `6h 12m` / `1m 23s` / `45s`, or `—` for a missing duration.
 *
 * Named for the session it measures rather than `formatDuration`: this renders a
 * wall-clock span in clock units, which is a different job from the μs→h ladder
 * in `./format`. Sharing the name meant the two got imported interchangeably.
 *
 * Minutes roll over at an hour: agent sessions that wait on a human run for
 * hours, and "360m 0s" is not a duration anyone reads as six.
 */
export function formatSessionDuration(ms: number | null): string {
	if (ms == null || ms < 0) return "—"
	const totalSeconds = Math.round(ms / 1000)
	const minutes = Math.floor(totalSeconds / 60)
	if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
	const seconds = totalSeconds % 60
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

/** Playhead clock `m:ss`. Clamps non-finite/negative input to 0. */
export function formatClock(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) ms = 0
	const totalSeconds = Math.floor(ms / 1000)
	const minutes = Math.floor(totalSeconds / 60)
	const seconds = totalSeconds % 60
	return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

/** Host + path for compact URL display; returns the raw input if unparseable. */
export function hostFromUrl(url: string): string {
	try {
		const u = new URL(url)
		return `${u.host}${u.pathname === "/" ? "" : u.pathname}`
	} catch {
		return url
	}
}

const AVATAR_GRADIENTS = [
	"from-rose-500/80 to-orange-400/80",
	"from-violet-500/80 to-fuchsia-400/80",
	"from-sky-500/80 to-cyan-400/80",
	"from-emerald-500/80 to-teal-400/80",
	"from-amber-500/80 to-yellow-400/80",
	"from-indigo-500/80 to-blue-400/80",
]

/** Deterministic avatar gradient for a session, keyed by a stable seed. */
export function gradientFor(seed: string): string {
	let hash = 0
	for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
	return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length]!
}

/** `true` for handheld device-type strings as reported by the browser SDK. */
export function isMobileDevice(deviceType: string): boolean {
	const d = deviceType.toLowerCase()
	return d === "mobile" || d === "tablet" || d === "phone"
}

// Relative-time formatting lives in `./time-format` — import `formatRelativeFrom`
// for an epoch-ms instant. The `Intl.RelativeTimeFormat` version that used to
// live here rendered "2 hours ago" while the rest of the app rendered "2h ago".
