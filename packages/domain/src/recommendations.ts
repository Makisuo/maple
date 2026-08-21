// Detects "messed up" span attribute keys in an org's telemetry and turns them into
// recommended ingest attribute mappings. Pure and dependency-free so it runs identically in the
// API reconcile loop (apps/api) and in unit tests, and so its types feed the HTTP layer.
//
// Grounded in OpenTelemetry semantic-convention migrations. The HTTP/network entries mirror the
// old↔new key handling in `@maple/ui/lib/http.ts`.
//
// Scope guardrail: the ingest mapping engine writes to a SPAN target key (it can rename a span
// attribute or promote a resource attribute onto spans, but cannot demote span→resource or
// rename resource→resource). So this dictionary is span-only — resource→resource renames such as
// `deployment.environment` → `deployment.environment.name` are deliberately excluded.

export type RecommendationKind = "rename" | "double-emission" | "naming"

interface AttributeRename {
	/** The non-conforming span attribute key as emitted. */
	deprecated: string
	/** The current OpenTelemetry semantic-convention key. */
	canonical: string
	/** One-line, human-readable explanation of the rename. */
	reason: string
	/** Whether the source key is a deprecated semconv key or a camelCase mistake. */
	category: "deprecated" | "camelcase"
}

export interface AttributeRecommendation {
	/** Stable dedupe id (e.g. `rename:http.status_code`). */
	id: string
	kind: RecommendationKind
	/** The offending span attribute key. */
	key: string
	/** Present for `rename` and `double-emission` rows. */
	canonical?: string
	reason: string
	/** Usage count of `key` on spans over the scanned window. */
	usageCount: number
	/** Only `rename` rows can be fixed by creating a mapping. */
	applyable: boolean
}

// Curated deprecated → current OTel semantic-convention renames. Every entry is an unambiguous,
// safe span-attribute rename where `deprecated !== canonical`.
const ATTRIBUTE_RENAMES: readonly AttributeRename[] = [
	// HTTP
	{
		deprecated: "http.method",
		canonical: "http.request.method",
		reason: "HTTP semconv renamed the request method attribute.",
		category: "deprecated",
	},
	{
		deprecated: "http.status_code",
		canonical: "http.response.status_code",
		reason: "Response status moved under the http.response.* namespace.",
		category: "deprecated",
	},
	{
		deprecated: "http.url",
		canonical: "url.full",
		reason: "Full request URL moved to the dedicated url.* namespace.",
		category: "deprecated",
	},
	{
		deprecated: "http.target",
		canonical: "url.path",
		reason: "Request target split into url.path (and url.query).",
		category: "deprecated",
	},
	{
		deprecated: "http.scheme",
		canonical: "url.scheme",
		reason: "Scheme moved to the url.* namespace.",
		category: "deprecated",
	},
	{
		deprecated: "http.host",
		canonical: "server.address",
		reason: "Host attribute generalized to server.address.",
		category: "deprecated",
	},
	{
		deprecated: "http.flavor",
		canonical: "network.protocol.version",
		reason: "Protocol version generalized under network.*.",
		category: "deprecated",
	},
	{
		deprecated: "http.request_content_length",
		canonical: "http.request.body.size",
		reason: "Renamed in the stable HTTP semconv.",
		category: "deprecated",
	},
	{
		deprecated: "http.response_content_length",
		canonical: "http.response.body.size",
		reason: "Renamed in the stable HTTP semconv.",
		category: "deprecated",
	},
	{
		deprecated: "http.user_agent",
		canonical: "user_agent.original",
		reason: "User agent moved to the user_agent.* namespace.",
		category: "deprecated",
	},
	// Network / socket
	{
		deprecated: "net.peer.name",
		canonical: "server.address",
		reason: "Peer name generalized to server.address.",
		category: "deprecated",
	},
	{
		deprecated: "net.peer.port",
		canonical: "server.port",
		reason: "Peer port generalized to server.port.",
		category: "deprecated",
	},
	{
		deprecated: "net.host.name",
		canonical: "server.address",
		reason: "Host name generalized to server.address.",
		category: "deprecated",
	},
	{
		deprecated: "net.host.port",
		canonical: "server.port",
		reason: "Host port generalized to server.port.",
		category: "deprecated",
	},
	{
		deprecated: "net.sock.peer.addr",
		canonical: "network.peer.address",
		reason: "Socket peer address moved to network.*.",
		category: "deprecated",
	},
	{
		deprecated: "net.sock.peer.port",
		canonical: "network.peer.port",
		reason: "Socket peer port moved to network.*.",
		category: "deprecated",
	},
	{
		deprecated: "net.transport",
		canonical: "network.transport",
		reason: "Transport moved to the network.* namespace.",
		category: "deprecated",
	},
	{
		deprecated: "net.protocol.name",
		canonical: "network.protocol.name",
		reason: "Protocol name moved to network.*.",
		category: "deprecated",
	},
	{
		deprecated: "net.protocol.version",
		canonical: "network.protocol.version",
		reason: "Protocol version moved to network.*.",
		category: "deprecated",
	},
	// Database
	{
		deprecated: "db.statement",
		canonical: "db.query.text",
		reason: "Database semconv renamed the statement attribute.",
		category: "deprecated",
	},
	{
		deprecated: "db.operation",
		canonical: "db.operation.name",
		reason: "Renamed in the stable database semconv.",
		category: "deprecated",
	},
	{
		deprecated: "db.system",
		canonical: "db.system.name",
		reason: "Database system attribute namespaced as db.system.name.",
		category: "deprecated",
	},
	{
		deprecated: "db.name",
		canonical: "db.namespace",
		reason: "Database name generalized to db.namespace.",
		category: "deprecated",
	},
	{
		deprecated: "db.sql.table",
		canonical: "db.collection.name",
		reason: "Table/collection name generalized to db.collection.name.",
		category: "deprecated",
	},
	// Messaging
	{
		deprecated: "messaging.destination",
		canonical: "messaging.destination.name",
		reason: "Destination namespaced under messaging.destination.*.",
		category: "deprecated",
	},
	{
		deprecated: "messaging.url",
		canonical: "server.address",
		reason: "Broker URL generalized to server.address.",
		category: "deprecated",
	},
	{
		deprecated: "messaging.protocol",
		canonical: "network.protocol.name",
		reason: "Messaging protocol moved to network.*.",
		category: "deprecated",
	},
	{
		deprecated: "messaging.protocol_version",
		canonical: "network.protocol.version",
		reason: "Messaging protocol version moved to network.*.",
		category: "deprecated",
	},
	// FaaS / user
	{
		deprecated: "faas.execution",
		canonical: "faas.invocation_id",
		reason: "FaaS execution id renamed to faas.invocation_id.",
		category: "deprecated",
	},
	{
		deprecated: "enduser.id",
		canonical: "user.id",
		reason: "Enduser attributes consolidated under user.*.",
		category: "deprecated",
	},
	// Common camelCase mistakes with a confident canonical target
	{
		deprecated: "httpMethod",
		canonical: "http.request.method",
		reason: "Non-conforming camelCase key — use the dotted semconv name.",
		category: "camelcase",
	},
	{
		deprecated: "httpStatusCode",
		canonical: "http.response.status_code",
		reason: "Non-conforming camelCase key — use the dotted semconv name.",
		category: "camelcase",
	},
	{
		deprecated: "httpUrl",
		canonical: "url.full",
		reason: "Non-conforming camelCase key — use the dotted semconv name.",
		category: "camelcase",
	},
	{
		deprecated: "httpRoute",
		canonical: "http.route",
		reason: "Non-conforming camelCase key — use the dotted semconv name.",
		category: "camelcase",
	},
	{
		deprecated: "dbStatement",
		canonical: "db.query.text",
		reason: "Non-conforming camelCase key — use the dotted semconv name.",
		category: "camelcase",
	},
	{
		deprecated: "dbOperation",
		canonical: "db.operation.name",
		reason: "Non-conforming camelCase key — use the dotted semconv name.",
		category: "camelcase",
	},
	{
		deprecated: "userId",
		canonical: "user.id",
		reason: "Non-conforming camelCase key — use the dotted semconv name.",
		category: "camelcase",
	},
]

/** How many generic camelCase advisories to surface, to bound noise. */
const NAMING_ADVISORY_LIMIT = 10

const KIND_RANK: Record<RecommendationKind, number> = {
	rename: 0,
	"double-emission": 1,
	naming: 2,
} satisfies Record<RecommendationKind, number>

/** camelCase, non-namespaced key (has an uppercase letter, no dot) — the clear naming violation. */
function isCamelCaseNoDot(key: string): boolean {
	return !key.includes(".") && /[A-Z]/.test(key)
}

/**
 * Detect recommended attribute mappings from the org's live span attribute keys.
 *
 * @param spanKeys                  Span attribute keys with usage counts (from the warehouse).
 * @param existingMappingSourceKeys Span-scoped `sourceKey`s already covered by a mapping — suppressed.
 * @param dismissedIds              Recommendation ids to suppress (unused server-side; kept for callers
 *                                  that want to filter client-side).
 */
export function detectAttributeRecommendations(
	spanKeys: ReadonlyArray<{ attributeKey: string; usageCount: number }>,
	existingMappingSourceKeys: ReadonlyArray<string>,
	dismissedIds: ReadonlyArray<string> = [],
): AttributeRecommendation[] {
	const present = new Set<string>()
	const usageByKey = new Map<string, number>()
	for (const { attributeKey, usageCount } of spanKeys) {
		present.add(attributeKey)
		usageByKey.set(attributeKey, usageCount)
	}

	const suppressedKeys = new Set(existingMappingSourceKeys)
	const dismissed = new Set(dismissedIds)
	const handledKeys = new Set<string>() // keys already turned into a rename/dual row

	const out: AttributeRecommendation[] = []

	for (const rule of ATTRIBUTE_RENAMES) {
		if (!present.has(rule.deprecated)) continue
		if (suppressedKeys.has(rule.deprecated)) continue
		handledKeys.add(rule.deprecated)

		const usageCount = usageByKey.get(rule.deprecated) ?? 0

		if (present.has(rule.canonical)) {
			// Canonical already exists on spans — a mapping would be a silent no-op (the Rust
			// applier never overwrites an existing target). Surface as a dismiss-only advisory.
			const id = `dual:${rule.deprecated}`
			if (dismissed.has(id)) continue
			out.push({
				id,
				kind: "double-emission",
				key: rule.deprecated,
				canonical: rule.canonical,
				reason: `Spans emit both ${rule.deprecated} and ${rule.canonical}. Standardize on ${rule.canonical} in your SDK — a mapping can't merge them, the canonical key already exists.`,
				usageCount,
				applyable: false,
			})
			continue
		}

		const id = `rename:${rule.deprecated}`
		if (dismissed.has(id)) continue
		out.push({
			id,
			kind: "rename",
			key: rule.deprecated,
			canonical: rule.canonical,
			reason: rule.reason,
			usageCount,
			applyable: true,
		})
	}

	// Generic naming advisories: camelCase, non-namespaced keys we can't confidently map.
	const namingCandidates: AttributeRecommendation[] = []
	for (const { attributeKey, usageCount } of spanKeys) {
		if (handledKeys.has(attributeKey)) continue
		if (suppressedKeys.has(attributeKey)) continue
		if (!isCamelCaseNoDot(attributeKey)) continue
		const id = `naming:${attributeKey}`
		if (dismissed.has(id)) continue
		namingCandidates.push({
			id,
			kind: "naming",
			key: attributeKey,
			reason: "Non-conforming key name — OpenTelemetry attributes use lowercase dotted.snake_case. Consider renaming at the SDK.",
			usageCount,
			applyable: false,
		})
	}
	namingCandidates.sort((a, b) => b.usageCount - a.usageCount || a.key.localeCompare(b.key))
	out.push(...namingCandidates.slice(0, NAMING_ADVISORY_LIMIT))

	out.sort(
		(a, b) =>
			KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
			b.usageCount - a.usageCount ||
			a.key.localeCompare(b.key),
	)

	return out
}

// Reconcile planning — pure decision logic for persisting recommendations as durable issues.
// Kept separate from IO so it can be unit-tested without a warehouse or database.

export type RecommendationIssueStatus = "open" | "dismissed" | "applied" | "resolved"

/** Minimal shape `planReconcileIssues` needs from a stored issue row. */
export interface ExistingIssueLike {
	id: string
	number: number
	recommendationKey: string
	sourceKey: string
	status: RecommendationIssueStatus
}

export interface PlannedIssueInsert {
	number: number
	recommendationKey: string
	kind: RecommendationKind
	sourceKey: string
	canonicalKey: string | null
	usageCount: number
}

export interface PlannedIssueUpdate {
	id: string
	/** Refreshed usage; absent when the issue is no longer detected. */
	usageCount?: number
	/** Status transition; absent means keep the current status. */
	nextStatus?: "open" | "applied" | "resolved"
}

export interface ReconcilePlan {
	inserts: PlannedIssueInsert[]
	updates: PlannedIssueUpdate[]
}

/**
 * Diff freshly-detected recommendations against stored issues:
 *  - newly detected            → insert as `open` with the next per-org number
 *  - detected + already stored  → refresh usage; a `resolved` row that's back → reopen
 *  - stored + no longer detected → an `open` row becomes `applied` (a mapping now covers the key)
 *                                  or `resolved` (fixed at the SDK); other statuses are left as-is
 *                                  (a user's dismissal sticks).
 */
export function planReconcileIssues(
	detected: ReadonlyArray<AttributeRecommendation>,
	existing: ReadonlyArray<ExistingIssueLike>,
	mappingSourceKeys: ReadonlyArray<string>,
): ReconcilePlan {
	const detectedByKey = new Map(detected.map((rec) => [rec.id, rec] as const))
	const existingByKey = new Map(existing.map((row) => [row.recommendationKey, row] as const))
	const mappingSet = new Set(mappingSourceKeys)

	let nextNumber = existing.reduce((max, row) => Math.max(max, row.number), 0) + 1

	const inserts: PlannedIssueInsert[] = []
	const updates: PlannedIssueUpdate[] = []

	for (const rec of detected) {
		const row = existingByKey.get(rec.id)
		if (!row) {
			inserts.push({
				number: nextNumber++,
				recommendationKey: rec.id,
				kind: rec.kind,
				sourceKey: rec.key,
				canonicalKey: rec.canonical ?? null,
				usageCount: rec.usageCount,
			})
			continue
		}
		updates.push({
			id: row.id,
			usageCount: rec.usageCount,
			nextStatus: row.status === "resolved" ? "open" : undefined,
		})
	}

	for (const row of existing) {
		if (detectedByKey.has(row.recommendationKey)) continue
		if (row.status !== "open") continue
		updates.push({
			id: row.id,
			nextStatus: mappingSet.has(row.sourceKey) ? "applied" : "resolved",
		})
	}

	return { inserts, updates }
}
