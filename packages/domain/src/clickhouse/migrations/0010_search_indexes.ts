const ATTRIBUTE_ITEMS = {
	ResourceAttributeItems:
		"arrayMap((k, v) -> concat(k, char(31), v), mapKeys(ResourceAttributes), mapValues(ResourceAttributes))",
	ScopeAttributeItems:
		"arrayMap((k, v) -> concat(k, char(31), v), mapKeys(ScopeAttributes), mapValues(ScopeAttributes))",
	LogAttributeItems:
		"arrayMap((k, v) -> concat(k, char(31), v), mapKeys(LogAttributes), mapValues(LogAttributes))",
	SpanAttributeItems:
		"arrayMap((k, v) -> concat(k, char(31), v), mapKeys(SpanAttributes), mapValues(SpanAttributes))",
} as const

const addColumn = (table: string, name: keyof typeof ATTRIBUTE_ITEMS): string =>
	`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} Array(String) DEFAULT ${ATTRIBUTE_ITEMS[name]}`

const addBloom = (table: string, name: string, expression: string): string =>
	`ALTER TABLE ${table} ADD INDEX IF NOT EXISTS ${name} ${expression} TYPE bloom_filter(0.01) GRANULARITY 1`

const materializeIndex = (table: string, name: string): string =>
	`ALTER TABLE ${table} MATERIALIZE INDEX ${name}`

/**
 * Portable search substrate for every supported ClickHouse release.
 *
 * Newer text indexes are installed separately as an optional, version-gated
 * schema feature. Keeping this migration 24.8-compatible means correctness and
 * direct-ingest readiness never depend on a performance-only feature.
 */
export const migration_0010_search_indexes = {
	version: 10,
	description: "Add portable log/trace attribute indexes and log token search",
	statements: [
		addColumn("logs", "ResourceAttributeItems"),
		addColumn("logs", "ScopeAttributeItems"),
		addColumn("logs", "LogAttributeItems"),
		addColumn("traces", "ResourceAttributeItems"),
		addColumn("traces", "ScopeAttributeItems"),
		addColumn("traces", "SpanAttributeItems"),

		addBloom("logs", "idx_resource_attr_keys", "mapKeys(ResourceAttributes)"),
		addBloom("logs", "idx_resource_attr_vals", "mapValues(ResourceAttributes)"),
		addBloom("logs", "idx_scope_attr_keys", "mapKeys(ScopeAttributes)"),
		addBloom("logs", "idx_scope_attr_vals", "mapValues(ScopeAttributes)"),
		addBloom("logs", "idx_log_attr_keys", "mapKeys(LogAttributes)"),
		addBloom("logs", "idx_log_attr_vals", "mapValues(LogAttributes)"),
		"ALTER TABLE logs ADD INDEX IF NOT EXISTS idx_lower_body lower(Body) TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 8",

		addBloom("traces", "idx_scope_attr_keys", "mapKeys(ScopeAttributes)"),
		addBloom("traces", "idx_scope_attr_vals", "mapValues(ScopeAttributes)"),

		materializeIndex("logs", "idx_resource_attr_keys"),
		materializeIndex("logs", "idx_resource_attr_vals"),
		materializeIndex("logs", "idx_scope_attr_keys"),
		materializeIndex("logs", "idx_scope_attr_vals"),
		materializeIndex("logs", "idx_log_attr_keys"),
		materializeIndex("logs", "idx_log_attr_vals"),
		materializeIndex("logs", "idx_lower_body"),
		materializeIndex("traces", "idx_scope_attr_keys"),
		materializeIndex("traces", "idx_scope_attr_vals"),
	],
} as const
