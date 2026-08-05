import { AlertRuleUpsertRequest } from "@maple/domain/http"
import {
	PLANETSCALE_STORAGE_RUNWAY_SQL,
	PLANETSCALE_STORAGE_USED_SQL,
} from "@maple/query-engine-integrations"
import { Schema } from "effect"
import type { AlertTemplateDefinition } from "./types"
import { templateTag } from "./types"

/**
 * Alert templates for the signals a PlanetScale database can page someone about.
 *
 * Branch OOM is deliberately absent: it arrives as a webhook, already opens a
 * `kind="integration"` triage issue, and already reaches people through the
 * error-notification policy. Duplicating it as a metric rule would double-notify
 * on an event that isn't a metric. It gets a timeline marker instead.
 */

const decodeDestinationIds = Schema.decodeUnknownSync(AlertRuleUpsertRequest.fields.destinationIds)

const numericParam = (values: Readonly<Record<string, string>>, key: string, fallback: number) => {
	const parsed = Number(values[key])
	return Number.isFinite(parsed) ? parsed : fallback
}

const DATABASE_PARAM = {
	key: "database",
	label: "Database",
	description: "Leave blank to watch every PlanetScale database in the organization.",
	required: false,
	placeholder: "main-db",
} as const

/**
 * Metrics queries honor exactly ONE `attr.*` equality filter — a second is
 * silently dropped. So a rule can't say "this database AND this branch"; it says
 * "this database" and groups by branch, which evaluates per branch and is the
 * honest version of the same intent.
 */
const whereFor = (database: string | undefined) =>
	database === undefined || database === ""
		? ""
		: `attr.planetscale_database_name = '${database.replace(/'/g, "''")}'`

const metricsDraft = (input: {
	readonly name: string
	readonly metricName: string
	readonly aggregation: string
	readonly database: string | undefined
}) => ({
	id: input.metricName,
	name: input.name,
	enabled: true,
	hidden: false,
	dataSource: "metrics" as const,
	signalSource: "default" as const,
	metricName: input.metricName,
	metricType: "gauge" as const,
	isMonotonic: false,
	whereClause: whereFor(input.database),
	aggregation: input.aggregation,
	stepInterval: "auto",
	orderByDirection: "desc" as const,
	addOns: { groupBy: true, having: false, orderBy: false, limit: false, legend: false },
	// Per branch, since the single-equality limit means the branch can't be a filter.
	groupBy: ["attr.planetscale_branch_name"],
	having: "",
	orderBy: "",
	limit: "",
	legend: "",
})

const REQUIREMENT = {
	kind: "integration",
	integrationId: "planetscale",
	label: "PlanetScale",
	missing: "PlanetScale not connected",
} as const

/**
 * MySQL/Vitess and Postgres expose the same concept under different metric
 * names, and an operator asking for "replica lag" means both. This is why
 * `build` returns an array.
 */
const REPLICA_LAG_METRICS = [
	{ metric: "planetscale_mysql_replica_lag_seconds", label: "MySQL" },
	{ metric: "planetscale_postgres_replica_lag_seconds", label: "Postgres" },
] as const

const CONNECTION_METRICS = [
	{ metric: "planetscale_edge_active_connections", label: "MySQL" },
	{ metric: "planetscale_edge_postgres_active_connections", label: "Postgres" },
] as const

const suffix = (database: string | undefined) =>
	database === undefined || database === "" ? "" : ` · ${database}`

export const PLANETSCALE_ALERT_TEMPLATES: ReadonlyArray<AlertTemplateDefinition> = [
	{
		id: "ps-replica-lag",
		name: "Replica lag",
		description: "Warns when a branch's replicas fall behind, before reads start returning stale rows.",
		category: "infrastructure",
		tags: ["planetscale", "database", "replication"],
		requirement: REQUIREMENT,
		requiredMetricPrefixes: ["planetscale_mysql_replica_lag", "planetscale_postgres_replica_lag"],
		parameters: [
			DATABASE_PARAM,
			{
				key: "thresholdSeconds",
				label: "Lag threshold (seconds)",
				description: "Fires when the worst replica in a branch exceeds this.",
				required: false,
				defaultValue: "30",
			},
		],
		build: ({ values, destinationIds, enabled }) =>
			REPLICA_LAG_METRICS.map(
				({ metric, label }) =>
					new AlertRuleUpsertRequest({
						name: `PlanetScale replica lag (${label})${suffix(values.database)}`,
						enabled,
						severity: "warning",
						signalType: "builder_query",
						comparator: "gt",
						threshold: numericParam(values, "thresholdSeconds", 30),
						windowMinutes: 5,
						// Two consecutive windows: replication catches up on its own
						// constantly, and a single spike is not an incident.
						consecutiveBreachesRequired: 2,
						tags: ["planetscale", templateTag("ps-replica-lag")],
						queryBuilderDraft: metricsDraft({
							name: "Replica lag",
							metricName: metric,
							aggregation: "max",
							database: values.database,
						}),
						destinationIds: decodeDestinationIds(destinationIds),
					}),
			),
	},
	{
		id: "ps-connection-ceiling",
		name: "Connection ceiling",
		description: "Warns when active connections approach the limit your plan allows.",
		category: "infrastructure",
		tags: ["planetscale", "database", "connections"],
		requirement: REQUIREMENT,
		requiredMetricPrefixes: ["planetscale_edge_active_connections"],
		parameters: [
			DATABASE_PARAM,
			{
				key: "threshold",
				label: "Connection threshold",
				// Required with no default on purpose: the ceiling is a property of
				// the PlanetScale plan and appears in no metric, so guessing one
				// would ship an alert that fires at a number nobody chose.
				description:
					"Your plan's connection limit, minus the headroom you want. Not derivable from the metrics.",
				required: true,
				placeholder: "800",
			},
		],
		build: ({ values, destinationIds, enabled }) =>
			CONNECTION_METRICS.map(
				({ metric, label }) =>
					new AlertRuleUpsertRequest({
						name: `PlanetScale connections (${label})${suffix(values.database)}`,
						enabled,
						severity: "warning",
						signalType: "builder_query",
						comparator: "gt",
						threshold: numericParam(values, "threshold", 0),
						windowMinutes: 5,
						consecutiveBreachesRequired: 2,
						tags: ["planetscale", templateTag("ps-connection-ceiling")],
						queryBuilderDraft: metricsDraft({
							name: "Active connections",
							metricName: metric,
							aggregation: "max",
							database: values.database,
						}),
						destinationIds: decodeDestinationIds(destinationIds),
					}),
			),
	},
	{
		id: "ps-storage-used",
		name: "Storage used",
		description: "Warns when a branch's volume crosses a usage threshold.",
		category: "infrastructure",
		tags: ["planetscale", "database", "storage"],
		requirement: REQUIREMENT,
		requiredMetricPrefixes: ["planetscale_volume_"],
		parameters: [
			{
				key: "thresholdPercent",
				label: "Used threshold (%)",
				description: "Fires when the worst branch's volume crosses this.",
				required: false,
				defaultValue: "85",
			},
		],
		build: ({ values, destinationIds, enabled }) => [
			new AlertRuleUpsertRequest({
				name: "PlanetScale storage used",
				enabled,
				severity: "warning",
				// raw_query, not builder_query: this is a ratio of two metrics, which
				// the metrics builder cannot express.
				signalType: "raw_query",
				comparator: "gt",
				threshold: numericParam(values, "thresholdPercent", 85),
				windowMinutes: 15,
				rawQuerySql: PLANETSCALE_STORAGE_USED_SQL,
				rawQueryReducer: "max",
				tags: ["planetscale", templateTag("ps-storage-used")],
				destinationIds: decodeDestinationIds(destinationIds),
			}),
		],
	},
	{
		id: "ps-storage-runway",
		name: "Storage runway",
		description:
			"Fires when a branch's volume is on track to fill within N days, from the slope of its free space.",
		category: "infrastructure",
		tags: ["planetscale", "database", "storage", "forecast"],
		requirement: REQUIREMENT,
		requiredMetricPrefixes: ["planetscale_volume_available_bytes"],
		parameters: [
			{
				key: "thresholdDays",
				label: "Runway threshold (days)",
				description: "Fires when the projected days-until-full drops below this.",
				required: false,
				defaultValue: "14",
			},
		],
		build: ({ values, destinationIds, enabled }) => [
			new AlertRuleUpsertRequest({
				name: "PlanetScale storage runway",
				enabled,
				severity: "critical",
				signalType: "raw_query",
				comparator: "lt",
				threshold: numericParam(values, "thresholdDays", 14),
				// A day of history is what makes the slope meaningful. This is exactly
				// MAX_ALERT_WINDOW_MINUTES — there is no headroom here, and the cap
				// should not be raised to buy some.
				windowMinutes: 1440,
				rawQuerySql: PLANETSCALE_STORAGE_RUNWAY_SQL,
				// min: the branch with the least runway is the one that matters.
				rawQueryReducer: "min",
				tags: ["planetscale", templateTag("ps-storage-runway")],
				destinationIds: decodeDestinationIds(destinationIds),
			}),
		],
	},
	{
		id: "ps-pod-saturation",
		name: "Pod saturation",
		description: "Warns when a branch's pods sit near their CPU or memory limit.",
		category: "infrastructure",
		tags: ["planetscale", "database", "saturation"],
		requirement: REQUIREMENT,
		requiredMetricPrefixes: ["planetscale_pods_"],
		parameters: [
			DATABASE_PARAM,
			{
				key: "thresholdPercent",
				label: "Utilization threshold (%)",
				description: "Fires when peak utilization stays above this.",
				required: false,
				defaultValue: "90",
			},
		],
		build: ({ values, destinationIds, enabled }) =>
			(
				[
					{ metric: "planetscale_pods_cpu_util_percentages", label: "CPU" },
					{ metric: "planetscale_pods_mem_util_percentages", label: "memory" },
				] as const
			).map(
				({ metric, label }) =>
					new AlertRuleUpsertRequest({
						name: `PlanetScale pod ${label}${suffix(values.database)}`,
						enabled,
						severity: "warning",
						signalType: "builder_query",
						comparator: "gt",
						threshold: numericParam(values, "thresholdPercent", 90),
						windowMinutes: 10,
						consecutiveBreachesRequired: 2,
						tags: ["planetscale", templateTag("ps-pod-saturation")],
						queryBuilderDraft: metricsDraft({
							name: `Pod ${label}`,
							metricName: metric,
							aggregation: "max",
							database: values.database,
						}),
						destinationIds: decodeDestinationIds(destinationIds),
					}),
			),
	},
]
