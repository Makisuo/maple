// Span-kind and span-status presentation — the single copies of two small maps
// that were previously duplicated across every trace tooltip and detail panel
// (web, local-ui, mobile, and twice inside this package). Kept dependency-free
// so non-DOM consumers (mobile) can import it; `span-category.ts` re-exports
// SPAN_KIND_LABELS for its existing importers.

/**
 * Canonical span kinds. The warehouse carries two spellings of the same value: the managed
 * (Tinybird) schema stores the OTLP enum name `SPAN_KIND_SERVER`, while the BYO-ClickHouse /
 * ClickStack schema stores the short `Server` (see `IsEntryPoint` in
 * `packages/domain/src/clickhouse`). Compare against a normalized kind, never against a raw
 * string — a `=== "SPAN_KIND_CONSUMER"` check silently never fires on BYO ClickHouse.
 */
export type SpanKind = "SERVER" | "CLIENT" | "PRODUCER" | "CONSUMER" | "INTERNAL"

const CANONICAL_KINDS: ReadonlySet<string> = new Set(["SERVER", "CLIENT", "PRODUCER", "CONSUMER", "INTERNAL"])

/** Both warehouse spellings (and any casing) → a canonical kind; `null` for anything else. */
export function normalizeSpanKind(spanKind: string | null | undefined): SpanKind | null {
	if (!spanKind) return null
	const bare = spanKind.replace(/^SPAN_KIND_/i, "").toUpperCase()
	return CANONICAL_KINDS.has(bare) ? (bare as SpanKind) : null
}

/** OTel span kind → human label ("SPAN_KIND_SERVER" and "Server" → "Server"). */
export const SPAN_KIND_LABELS: Record<string, string> = {
	SPAN_KIND_SERVER: "Server",
	SPAN_KIND_CLIENT: "Client",
	SPAN_KIND_PRODUCER: "Producer",
	SPAN_KIND_CONSUMER: "Consumer",
	SPAN_KIND_INTERNAL: "Internal",
} satisfies Record<string, string>

/** Human label for a span kind, degrading gracefully for unknown/absent kinds. */
export function getSpanKindLabel(spanKind: string | null | undefined): string {
	if (!spanKind) return "Unknown"
	const kind = normalizeSpanKind(spanKind)
	if (kind) return SPAN_KIND_LABELS[`SPAN_KIND_${kind}`] ?? kind
	return SPAN_KIND_LABELS[spanKind] ?? spanKind.replace("SPAN_KIND_", "")
}

/** Span status (`Ok`/`Error`/`Unset`, Title case per Maple convention) → badge classes. */
export const SPAN_STATUS_BADGE_CLASSES: Record<string, string> = {
	Ok: "bg-severity-info/15 text-severity-info border-severity-info/30",
	Error: "bg-severity-error/15 text-severity-error border-severity-error/30",
	Unset: "bg-muted text-muted-foreground border-border",
} satisfies Record<string, string>

/** Badge classes for a span status, treating unknown statuses as `Unset`. */
export function getSpanStatusBadgeClass(statusCode: string | null | undefined): string {
	return (statusCode && SPAN_STATUS_BADGE_CLASSES[statusCode]) || SPAN_STATUS_BADGE_CLASSES.Unset
}
