import type { V2DashboardTemplate } from "@maple/domain/http/v2"
import { formatRelativeFrom, toEpochMs } from "@maple/ui/lib/time-format"

/**
 * The empty-dashboard template. It is pinned below the list as its own row
 * rather than living in the catalogue, so it is excluded from every count.
 */
export const BLANK_TEMPLATE_ID = "blank"

/** Category ids as they read in the UI. */
export const CATEGORY_LABELS: Record<string, string> = {
	application: "Application",
	database: "Databases",
	infrastructure: "Infrastructure",
	messaging: "Messaging",
}

export const CATEGORY_ORDER = ["application", "database", "infrastructure", "messaging"] as const

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * "3 stats · 3 charts" from the template's preview metadata. Line, area and bar
 * all read as charts — the distinction matters to the renderer, not the reader.
 */
export function compositionLabel(preview: V2DashboardTemplate["preview"]): string {
	const counts = { stat: 0, chart: 0, table: 0, list: 0 }
	for (const widget of preview) {
		if (widget.kind === "stat") counts.stat++
		else if (widget.kind === "table") counts.table++
		else if (widget.kind === "list") counts.list++
		else counts.chart++
	}
	const parts: string[] = []
	if (counts.stat > 0) parts.push(plural(counts.stat, "stat", "stats"))
	if (counts.chart > 0) parts.push(plural(counts.chart, "chart", "charts"))
	if (counts.table > 0) parts.push(plural(counts.table, "table", "tables"))
	if (counts.list > 0) parts.push(plural(counts.list, "list", "lists"))
	return parts.join(" · ")
}

export const widgetCountLabel = (template: V2DashboardTemplate): string =>
	plural(template.preview.length, "widget", "widgets")

/** Where a gated template sends you to fix the gap. */
export const setupDestination = (
	template: V2DashboardTemplate,
): { to: string; search?: Record<string, string> } =>
	template.requirement?.kind === "integration"
		? { to: "/integrations" }
		: { to: "/settings", search: { tab: "ingestion" } }

/** Matches name, description and tags — exactly what the result strip claims. */
export function templateMatches(template: V2DashboardTemplate, query: string): boolean {
	const needle = query.trim().toLowerCase()
	if (needle.length === 0) return true
	return (
		template.name.toLowerCase().includes(needle) ||
		template.description.toLowerCase().includes(needle) ||
		template.tags.some((tag) => tag.toLowerCase().includes(needle))
	)
}

/** "12s ago" / "4m ago" / "3h ago", or null when the timestamp is unusable. */
export function relativeAge(iso: string | null, now: number): string | null {
	if (iso === null) return null
	const epochMs = toEpochMs(iso)
	if (!Number.isFinite(epochMs)) return null
	return formatRelativeFrom(epochMs, now)
}
