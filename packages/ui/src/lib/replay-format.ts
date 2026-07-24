// Shared presentation helpers for the session-replay surfaces (list, detail,
// player, timeline) — used by both the web app and the local-mode UI so the
// two can't drift. Warehouse-coupled helpers (partition windows) stay in the
// web app: this package doesn't depend on @maple/query-engine.

/** `1m 23s` / `45s`, or `—` for missing/zero durations. */
export function formatDuration(ms: number | null): string {
	if (ms == null || ms <= 0) return "—"
	const totalSeconds = Math.round(ms / 1000)
	const minutes = Math.floor(totalSeconds / 60)
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

const RELATIVE_UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
	["year", 365 * 24 * 60 * 60 * 1000],
	["month", 30 * 24 * 60 * 60 * 1000],
	["day", 24 * 60 * 60 * 1000],
	["hour", 60 * 60 * 1000],
	["minute", 60 * 1000],
	["second", 1000],
]

const relativeFmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

/** `2h ago` / `just now` for an epoch-ms instant, relative to `nowMs` (defaults to Date.now()). */
export function formatRelativeTime(epochMs: number, nowMs: number = Date.now()): string {
	if (!Number.isFinite(epochMs)) return "—"
	const deltaMs = epochMs - nowMs
	const abs = Math.abs(deltaMs)
	if (abs < 5_000) return "just now"
	for (const [unit, ms] of RELATIVE_UNITS) {
		if (abs >= ms) return relativeFmt.format(Math.round(deltaMs / ms), unit)
	}
	return "just now"
}
