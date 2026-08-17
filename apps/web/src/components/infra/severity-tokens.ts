// Canonical severity/status → Tailwind class maps for the infrastructure UI.
// Keyed by the shared `SeverityLevel` / `HostStatus` unions from `./format`, so
// the severity palette lives in one place instead of being re-encoded per file.

import type { HostStatus, SeverityLevel } from "./format"

export type Tone = SeverityLevel | "neutral"

/** KPI value text tone (stat-rail, detail headers). */
export const VALUE_TONE: Record<Tone, string> = {
	neutral: "text-foreground",
	ok: "text-foreground",
	warn: "text-[var(--severity-warn)]",
	crit: "text-[var(--severity-error)]",
} satisfies Record<Tone, string>

/** Sparkline fill — a raw CSS var string (consumed as an SVG `fill`, not a class). */
export const SPARK_COLOR: Record<Tone, string> = {
	neutral: "var(--primary)",
	ok: "var(--severity-info)",
	warn: "var(--severity-warn)",
	crit: "var(--severity-error)",
} satisfies Record<Tone, string>

/** Solid severity fill for inline meter bars. */
export const BAR_FILL: Record<SeverityLevel, string> = {
	ok: "bg-[var(--severity-info)]",
	warn: "bg-[var(--severity-warn)]",
	crit: "bg-[var(--severity-error)]",
} satisfies Record<SeverityLevel, string>

/** Dimmer value-text tone used inside compact bar widgets. */
export const BAR_VALUE_TONE: Record<SeverityLevel, string> = {
	ok: "text-foreground/75",
	warn: "text-[var(--severity-warn)]",
	crit: "text-[var(--severity-error)]",
} satisfies Record<SeverityLevel, string>

/** Status dot fill. */
export const STATUS_DOT: Record<HostStatus, string> = {
	active: "bg-[var(--severity-info)]",
	idle: "bg-muted-foreground/60",
	down: "bg-[var(--severity-error)]",
} satisfies Record<HostStatus, string>

/** Status dot ring. */
export const STATUS_RING: Record<HostStatus, string> = {
	active: "ring-[color-mix(in_oklab,var(--severity-info)_45%,transparent)]",
	idle: "ring-border",
	down: "ring-[color-mix(in_oklab,var(--severity-error)_45%,transparent)]",
} satisfies Record<HostStatus, string>

/** Pulse fill behind an active status dot. */
export const STATUS_PULSE = "bg-[color-mix(in_oklab,var(--severity-info)_55%,transparent)]"

const STATUS_LABEL: Record<HostStatus, string> = {
	active: "Active",
	idle: "Idle",
	down: "Down",
} satisfies Record<HostStatus, string>

/** Human-readable status word, paired with color so it is never the sole signal. */
export function statusLabel(status: HostStatus): string {
	return STATUS_LABEL[status]
}
