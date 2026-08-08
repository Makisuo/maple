// Thresholds, tones, and formatting for the PlanetScale metrics.
//
// Every PlanetScale surface — the fleet table, the branch table, the detail
// charts, the stat rails, the service-map panel — reads its severity from here.
// That matters: `severityLevel()` in ../format takes a 0–1 fraction and goes
// crit at 0.9, while these gauges arrive as 0–100 percentages and go crit at 80.
// Deriving the cell class and the KPI tone from two different scales is how you
// end up with an amber number next to a red one for the same 85%.

import type { Tone } from "../severity-tokens"
import { VALUE_TONE } from "../severity-tokens"

/** Metrics missing for the window sort below every real value (see `useTableSort`). */
export const MISSING = Number.NEGATIVE_INFINITY

/** Utilization percentage (0–100) → tone. Shared by CPU, memory, and storage. */
export function utilizationTone(percent: number): Tone {
	if (!Number.isFinite(percent)) return "neutral"
	if (percent > 80) return "crit"
	if (percent > 60) return "warn"
	return "neutral"
}

/** Replica lag in seconds → tone. A second of lag is already worth noticing. */
export function lagTone(seconds: number): Tone {
	if (!Number.isFinite(seconds)) return "neutral"
	if (seconds > 10) return "crit"
	if (seconds > 1) return "warn"
	return "neutral"
}

/** Table-cell tint for a utilization percentage; `undefined` leaves the default. */
export function utilizationClass(percent: number): string | undefined {
	const tone = utilizationTone(percent)
	return tone === "neutral" ? undefined : VALUE_TONE[tone]
}

/** Table-cell tint for replica lag; `undefined` leaves the default. */
export function lagClass(seconds: number): string | undefined {
	const tone = lagTone(seconds)
	return tone === "neutral" ? undefined : VALUE_TONE[tone]
}

/** Replica lag reads in seconds once it is a real problem, milliseconds while it isn't. */
export const formatLag = (seconds: number) =>
	seconds >= 1 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds * 1000)}ms`

/** Storage used as a whole percentage — the number people quote about a full disk. */
export const formatStoragePercent = (percent: number) =>
	`${percent >= 99.5 || percent < 10 ? percent.toFixed(1) : percent.toFixed(0)}%`

/** States that mean the database isn't serving normally — worth a badge. */
export function abnormalState(state: string | null): string | null {
	if (state === null) return null
	const normalized = state.toLowerCase()
	return normalized === "ready" || normalized === "active" ? null : normalized
}

/**
 * PlanetScale's brand mark color, used by the service-map node accent and the
 * integrations catalog tile. One value so the two can't drift.
 */
export const PLANETSCALE_COLOR = "oklch(0.62 0.02 270)"
