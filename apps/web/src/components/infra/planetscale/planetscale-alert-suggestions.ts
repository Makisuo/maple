// Alert rules worth offering from a PlanetScale database page.
//
// Pure: the draft shapes only, so the copy and the metric choices are testable
// without a router. The menu component turns one of these into a prefilled
// /alerts/create link via the same `encodeAlertChartToSearchParam` mechanism the
// metrics explorer uses — no new route, no new form.

import type { MetricsQueryDraft } from "@/lib/query-builder/model"

export interface PlanetScaleAlertSuggestion {
	readonly id: "storage-headroom" | "replica-lag" | "connection-ceiling"
	readonly title: string
	/** The rule in one line, e.g. "replica lag > 30s over 5 min". */
	readonly summary: string
	readonly draft: MetricsQueryDraft
}

/**
 * Metrics queries honor exactly ONE `attr.*` equality filter — a second is
 * silently dropped, which would produce a rule that alerts on *any* branch while
 * appearing to watch one. So the draft filters on the database and groups by
 * branch, which evaluates per branch and is the honest form of the same intent.
 */
const draftFor = (input: {
	readonly name: string
	readonly metricName: string
	readonly aggregation: string
	readonly database: string
}): MetricsQueryDraft => ({
	id: crypto.randomUUID(),
	name: input.name,
	enabled: true,
	hidden: false,
	dataSource: "metrics",
	signalSource: "default",
	metricName: input.metricName,
	metricType: "gauge",
	isMonotonic: false,
	whereClause: `attr.planetscale_database_name = '${input.database.replace(/'/g, "''")}'`,
	aggregation: input.aggregation,
	stepInterval: "auto",
	orderByDirection: "desc",
	addOns: { groupBy: true, having: false, orderBy: false, limit: false, legend: false },
	groupBy: ["attr.planetscale_branch_name"],
	having: "",
	orderBy: "",
	limit: "",
	legend: "",
})

/**
 * @param kind The database's product — MySQL/Vitess and Postgres report the same
 * concepts under different metric names, so the suggestion has to pick.
 */
export function planetScaleAlertSuggestions(input: {
	readonly database: string
	readonly kind: string
}): ReadonlyArray<PlanetScaleAlertSuggestion> {
	const postgres = input.kind === "postgresql"
	return [
		{
			id: "storage-headroom",
			title: "Storage headroom",
			// PlanetScale reports FREE bytes, never used bytes, and the query builder
			// can't divide one metric by another — so the offer is "free space below
			// X", which is also the truer statement.
			summary: "free space below a threshold",
			draft: draftFor({
				name: "Free volume space",
				metricName: "planetscale_volume_available_bytes",
				aggregation: "min",
				database: input.database,
			}),
		},
		{
			id: "replica-lag",
			title: "Replica lag",
			summary: "worst replica behind by more than a few seconds",
			draft: draftFor({
				name: "Replica lag",
				metricName: postgres
					? "planetscale_postgres_replica_lag_seconds"
					: "planetscale_mysql_replica_lag_seconds",
				aggregation: "max",
				database: input.database,
			}),
		},
		{
			id: "connection-ceiling",
			title: "Connection ceiling",
			summary: "active connections approaching your plan's limit",
			draft: draftFor({
				name: "Active connections",
				metricName: postgres
					? "planetscale_edge_postgres_active_connections"
					: "planetscale_edge_active_connections",
				aggregation: "max",
				database: input.database,
			}),
		},
	]
}
