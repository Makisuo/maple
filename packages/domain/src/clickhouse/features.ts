/**
 * Performance-only ClickHouse schema features.
 *
 * Unlike correctness migrations, these are reconciled only when a server can
 * support them and do not participate in `clickHouseSchemaVersion` (which
 * gates direct ingest). A 24.8 cluster is therefore fully ready with the
 * portable schema, while a later server upgrade can pick up newer indexes on
 * the next schema Apply.
 */

export interface ClickHouseSchemaFeature {
	readonly id: string
	readonly revision: number
	readonly description: string
	readonly minClickHouseVersion?: string
	readonly satisfiedBySortingKey?: {
		readonly table: string
		readonly expected: string
	}
	readonly statements: ReadonlyArray<string>
}

const textIndex = (
	table: string,
	name: string,
	expression: string,
	tokenizer: "array" | "splitByNonAlpha",
	granularity: number,
): ReadonlyArray<string> => [
	`ALTER TABLE ${table} ADD INDEX IF NOT EXISTS ${name} ${expression} TYPE text(tokenizer = '${tokenizer}') GRANULARITY ${granularity}`,
	`ALTER TABLE ${table} MATERIALIZE INDEX ${name}`,
]

export const clickHouseSchemaFeatures: ReadonlyArray<ClickHouseSchemaFeature> = [
	{
		id: "search_text_v1",
		revision: 1,
		description: "Install full-text log and attribute indexes",
		minClickHouseVersion: "26.2.0",
		statements: [
			...textIndex("logs", "idx_resource_attr_items_text", "ResourceAttributeItems", "array", 1),
			...textIndex("logs", "idx_scope_attr_items_text", "ScopeAttributeItems", "array", 1),
			...textIndex("logs", "idx_log_attr_items_text", "LogAttributeItems", "array", 1),
			...textIndex("logs", "idx_lower_body_text", "lower(Body)", "splitByNonAlpha", 64),
			...textIndex("traces", "idx_resource_attr_items_text", "ResourceAttributeItems", "array", 1),
			...textIndex("traces", "idx_scope_attr_items_text", "ScopeAttributeItems", "array", 1),
			...textIndex("traces", "idx_span_attr_items_text", "SpanAttributeItems", "array", 1),
		],
	},
	{
		id: "logs_time_projection_v1",
		revision: 1,
		description: "Install the tenant/time-first log access path on legacy tables",
		satisfiedBySortingKey: {
			table: "logs",
			expected: "OrgId, toStartOfFiveMinutes(Timestamp), ServiceName, Timestamp",
		},
		statements: [
			`ALTER TABLE logs ADD PROJECTION IF NOT EXISTS logs_by_time (
  SELECT *
  ORDER BY (OrgId, toStartOfFiveMinutes(Timestamp), ServiceName, Timestamp)
)`,
			"ALTER TABLE logs MATERIALIZE PROJECTION logs_by_time",
		],
	},
] as const

const parseVersion = (version: string): readonly [number, number, number] => {
	const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim())
	return [Number(match?.[1] ?? 0), Number(match?.[2] ?? 0), Number(match?.[3] ?? 0)]
}

export const clickHouseVersionAtLeast = (actual: string, minimum: string): boolean => {
	const left = parseVersion(actual)
	const right = parseVersion(minimum)
	for (let i = 0; i < 3; i++) {
		if (left[i]! > right[i]!) return true
		if (left[i]! < right[i]!) return false
	}
	return true
}

export const featureSupportedByVersion = (feature: ClickHouseSchemaFeature, serverVersion: string): boolean =>
	feature.minClickHouseVersion === undefined ||
	clickHouseVersionAtLeast(serverVersion, feature.minClickHouseVersion)
