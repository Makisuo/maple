// Relative-time formatting — the single implementation.
//
// This module replaced fourteen independent relative-time formatters spread
// across web, local-ui and this package. They disagreed on wording ("now" vs
// "Just now" vs "0s ago"), on rounding (round vs floor), on how far the ladder
// went (most stopped at days), and — worst — on whether they normalized tz-less
// warehouse timestamps at all.
//
// The input-shape differences that motivated all those copies (ISO string vs
// `Date` vs epoch-ms) are handled by coercion here, not by flags: `TimeInput`
// absorbs all three, and the `*From` variants skip coercion for callers that
// already hold epoch-ms. Style variants ("3h ago" vs "3h") are separate exports
// rather than a `short` boolean, so a call site reads as what it renders.
//
// Import the `@maple/query-engine/datetime` leaf, never the package root — the
// root barrel pulls the drivers and would bloat every bundle that touches `cn`.

import { parseWarehouseDateTime } from "@maple/query-engine/datetime"

export type TimeInput = string | number | Date

/**
 * Coerce any supported instant to epoch milliseconds, treating tz-less warehouse
 * DateTime strings (`YYYY-MM-DD HH:MM:SS`) as UTC. Returns `NaN` when the input
 * can't be parsed — callers render their own placeholder.
 */
export function toEpochMs(input: TimeInput): number {
	if (typeof input === "number") return input
	if (input instanceof Date) return input.getTime()
	return parseWarehouseDateTime(input)
}

export type RelativeUnit = "s" | "m" | "h" | "d" | "mo" | "y"

export interface RelativeParts {
	readonly value: number
	readonly unit: RelativeUnit
	/** True when the instant is ahead of `nowMs` (clock skew, scheduled items). */
	readonly future: boolean
}

const MINUTE = 60
const HOUR = MINUTE * 60
const DAY = HOUR * 24
const MONTH = DAY * 30
const YEAR = DAY * 365

/**
 * Decompose the gap between `epochMs` and `nowMs` into a value + unit. Exposed so
 * callers can render their own wording (e.g. a `<time>` element with a full
 * tooltip) off the same ladder every formatter here uses.
 *
 * Floors rather than rounds: "59m ago" should not become "1h ago" until an hour
 * has actually passed.
 */
export function relativeParts(epochMs: number, nowMs: number = Date.now()): RelativeParts {
	const deltaMs = nowMs - epochMs
	const future = deltaMs < 0
	const seconds = Math.floor(Math.abs(deltaMs) / 1000)

	if (seconds < MINUTE) return { value: seconds, unit: "s", future }
	if (seconds < HOUR) return { value: Math.floor(seconds / MINUTE), unit: "m", future }
	if (seconds < DAY) return { value: Math.floor(seconds / HOUR), unit: "h", future }
	if (seconds < MONTH) return { value: Math.floor(seconds / DAY), unit: "d", future }
	if (seconds < YEAR) return { value: Math.floor(seconds / MONTH), unit: "mo", future }
	return { value: Math.floor(seconds / YEAR), unit: "y", future }
}

/** `"3h ago"` / `"in 3h"` / `"just now"`, from an epoch-ms instant. */
export function formatRelativeFrom(epochMs: number, nowMs: number = Date.now()): string {
	if (!Number.isFinite(epochMs)) return "—"
	const { value, unit, future } = relativeParts(epochMs, nowMs)
	if (unit === "s" && value < 5) return "just now"
	return future ? `in ${value}${unit}` : `${value}${unit} ago`
}

/** `"3h"` / `"now"`, from an epoch-ms instant. For dense table cells and chips. */
export function formatRelativeShortFrom(epochMs: number, nowMs: number = Date.now()): string {
	if (!Number.isFinite(epochMs)) return "—"
	const { value, unit } = relativeParts(epochMs, nowMs)
	if (unit === "s" && value < 5) return "now"
	return `${value}${unit}`
}

/** `"3h ago"` from an ISO string, warehouse DateTime, `Date`, or epoch-ms. */
export function formatRelativeTime(input: TimeInput, nowMs: number = Date.now()): string {
	return formatRelativeFrom(toEpochMs(input), nowMs)
}

/** `"3h"` from an ISO string, warehouse DateTime, `Date`, or epoch-ms. */
export function formatRelativeShort(input: TimeInput, nowMs: number = Date.now()): string {
	return formatRelativeShortFrom(toEpochMs(input), nowMs)
}

const RELATIVE_CUTOVER_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Relative inside the last week, an absolute locale date beyond it. Past a few
 * days "23d ago" stops being easier to read than the date itself.
 */
export function formatRelativeTimeOrDate(input: TimeInput, nowMs: number = Date.now()): string {
	const epochMs = toEpochMs(input)
	if (!Number.isFinite(epochMs)) return "—"
	if (nowMs - epochMs >= RELATIVE_CUTOVER_MS) {
		return new Date(epochMs).toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
			year: "numeric",
		})
	}
	return formatRelativeFrom(epochMs, nowMs)
}
