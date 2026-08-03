import { toEpochMs } from "@maple/ui/lib/time-format"

// Generic number/byte/percent formatting lives in `@maple/ui/lib/format`; only
// infra-specific status policy stays here.

export type HostStatus = "active" | "idle" | "down"
export type SeverityLevel = "ok" | "warn" | "crit"

export function severityLevel(fraction: number): SeverityLevel {
	if (!Number.isFinite(fraction)) return "ok"
	if (fraction >= 0.9) return "crit"
	if (fraction >= 0.6) return "warn"
	return "ok"
}

const SCRAPE_INTERVAL_MS = 30_000

export function deriveHostStatus(lastSeenIso: string, reference: number | string = Date.now()): HostStatus {
	const lastSeen = toEpochMs(lastSeenIso)
	if (!Number.isFinite(lastSeen)) return "down"
	const referenceMs = typeof reference === "number" ? reference : toEpochMs(reference)
	const ref = Number.isFinite(referenceMs) ? referenceMs : Date.now()
	const age = ref - lastSeen
	if (age < SCRAPE_INTERVAL_MS * 2) return "active"
	if (age < SCRAPE_INTERVAL_MS * 10) return "idle"
	return "down"
}
