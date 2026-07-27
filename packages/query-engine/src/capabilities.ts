/**
 * Runtime ClickHouse capabilities discovered from the warehouse that will
 * execute a query. These are deliberately evidence-based: a server version is
 * useful context, but an optimization is enabled only when the matching live
 * column/index is present.
 */
import { Schema } from "effect"

export type WarehouseSearchFeature =
	| "logs.body.tokenbf"
	| "logs.body.text"
	| "logs.attributes.bloom"
	| "logs.attributes.text"
	| "traces.attributes.bloom"
	| "traces.attributes.text"
	| "logs.time_projection"

export interface WarehouseIndexCapability {
	readonly table: string
	readonly name: string
	readonly type: string
	readonly expression: string
}

export interface WarehouseCapabilities {
	readonly serverVersion: string | undefined
	readonly features: ReadonlySet<WarehouseSearchFeature>
	readonly columns: ReadonlySet<string>
	readonly indexes: ReadonlyMap<string, WarehouseIndexCapability>
	readonly fullTextSearchSetting: "enabled" | "available" | "unavailable"
	readonly metadataAvailable: boolean
}

export interface WarehouseIndexMetadataRow {
	readonly table: string
	readonly name: string
	readonly type: string
	readonly expression?: string
	readonly expr?: string
}

export interface WarehouseColumnMetadataRow {
	readonly table: string
	readonly name: string
}

export interface WarehouseProjectionMetadataRow {
	readonly table: string
	readonly name: string
}

export interface WarehouseSettingMetadataRow {
	readonly name: string
	readonly value: string | number
}

export const WarehouseVersionMetadataSchema = Schema.Array(Schema.Struct({ version: Schema.String }))
export const WarehouseIndexMetadataSchema = Schema.Array(
	Schema.Struct({
		table: Schema.String,
		name: Schema.String,
		type: Schema.String,
		expression: Schema.optionalKey(Schema.String),
		expr: Schema.optionalKey(Schema.String),
	}),
)
export const WarehouseColumnMetadataSchema = Schema.Array(
	Schema.Struct({ table: Schema.String, name: Schema.String }),
)
export const WarehouseProjectionMetadataSchema = Schema.Array(
	Schema.Struct({ table: Schema.String, name: Schema.String }),
)
export const WarehouseSettingMetadataSchema = Schema.Array(
	Schema.Struct({ name: Schema.String, value: Schema.Union([Schema.String, Schema.Number]) }),
)

export const baselineWarehouseCapabilities = (): WarehouseCapabilities => ({
	serverVersion: undefined,
	features: new Set(),
	columns: new Set(),
	indexes: new Map(),
	fullTextSearchSetting: "unavailable",
	metadataAvailable: false,
})

const indexKey = (table: string, name: string): string => `${table}.${name}`
const columnKey = (table: string, name: string): string => `${table}.${name}`

const hasIndexType = (
	indexes: ReadonlyMap<string, WarehouseIndexCapability>,
	table: string,
	name: string,
	typePrefix: string,
): boolean => indexes.get(indexKey(table, name))?.type.toLowerCase().startsWith(typePrefix) ?? false

const hasColumn = (columns: ReadonlySet<string>, table: string, name: string): boolean =>
	columns.has(columnKey(table, name))

export const deriveWarehouseCapabilities = (input: {
	readonly serverVersion?: string
	readonly indexes: ReadonlyArray<WarehouseIndexMetadataRow>
	readonly columns: ReadonlyArray<WarehouseColumnMetadataRow>
	readonly projections?: ReadonlyArray<WarehouseProjectionMetadataRow>
	readonly settings?: ReadonlyArray<WarehouseSettingMetadataRow>
	/** Managed gateways may expose settings metadata but reject inline overrides. */
	readonly allowSettingOverrides?: boolean
}): WarehouseCapabilities => {
	const indexes = new Map<string, WarehouseIndexCapability>()
	for (const row of input.indexes) {
		indexes.set(indexKey(row.table, row.name), {
			table: row.table,
			name: row.name,
			type: row.type,
			expression: row.expression ?? row.expr ?? "",
		})
	}
	const columns = new Set(input.columns.map((row) => columnKey(row.table, row.name)))
	const projections = new Set((input.projections ?? []).map((row) => indexKey(row.table, row.name)))
	const features = new Set<WarehouseSearchFeature>()
	const fullTextSetting = input.settings?.find((row) => row.name === "enable_full_text_index")
	const fullTextSearchSetting =
		String(fullTextSetting?.value ?? "0") === "1"
			? "enabled"
			: fullTextSetting && input.allowSettingOverrides
				? "available"
				: "unavailable"

	if (
		fullTextSearchSetting !== "unavailable" &&
		hasIndexType(indexes, "logs", "idx_lower_body_text", "text")
	) {
		features.add("logs.body.text")
	} else if (hasIndexType(indexes, "logs", "idx_lower_body", "tokenbf_v1")) {
		features.add("logs.body.tokenbf")
	}

	const logsBloomNames = [
		"idx_resource_attr_keys",
		"idx_resource_attr_vals",
		"idx_scope_attr_keys",
		"idx_scope_attr_vals",
		"idx_log_attr_keys",
		"idx_log_attr_vals",
	] as const
	if (logsBloomNames.every((name) => hasIndexType(indexes, "logs", name, "bloom_filter"))) {
		features.add("logs.attributes.bloom")
	}

	const tracesBloomNames = [
		"idx_span_attr_keys",
		"idx_span_attr_vals",
		"idx_resource_attr_keys",
		"idx_resource_attr_vals",
	] as const
	if (tracesBloomNames.every((name) => hasIndexType(indexes, "traces", name, "bloom_filter"))) {
		features.add("traces.attributes.bloom")
	}

	const logsTextItems = [
		["ResourceAttributeItems", "idx_resource_attr_items_text"],
		["ScopeAttributeItems", "idx_scope_attr_items_text"],
		["LogAttributeItems", "idx_log_attr_items_text"],
	] as const
	if (
		fullTextSearchSetting !== "unavailable" &&
		logsTextItems.every(
			([column, index]) =>
				hasColumn(columns, "logs", column) && hasIndexType(indexes, "logs", index, "text"),
		)
	) {
		features.add("logs.attributes.text")
	}

	const tracesTextItems = [
		["ResourceAttributeItems", "idx_resource_attr_items_text"],
		["ScopeAttributeItems", "idx_scope_attr_items_text"],
		["SpanAttributeItems", "idx_span_attr_items_text"],
	] as const
	if (
		fullTextSearchSetting !== "unavailable" &&
		tracesTextItems.every(
			([column, index]) =>
				hasColumn(columns, "traces", column) && hasIndexType(indexes, "traces", index, "text"),
		)
	) {
		features.add("traces.attributes.text")
	}

	if (projections.has("logs.logs_by_time")) features.add("logs.time_projection")

	return {
		serverVersion: input.serverVersion,
		features,
		columns,
		indexes,
		fullTextSearchSetting,
		metadataAvailable: true,
	}
}

export const hasWarehouseFeature = (
	capabilities: WarehouseCapabilities,
	feature: WarehouseSearchFeature,
): boolean => capabilities.features.has(feature)

export type AttributeIndexMode = "none" | "bloom" | "text"
export type LogBodySearchMode = "scan" | "tokenbf" | "text"

export const attributeIndexMode = (
	capabilities: WarehouseCapabilities,
	table: "logs" | "traces",
): AttributeIndexMode => {
	if (hasWarehouseFeature(capabilities, `${table}.attributes.text`)) return "text"
	if (hasWarehouseFeature(capabilities, `${table}.attributes.bloom`)) return "bloom"
	return "none"
}

export const logBodySearchMode = (capabilities: WarehouseCapabilities): LogBodySearchMode => {
	if (hasWarehouseFeature(capabilities, "logs.body.text")) return "text"
	if (hasWarehouseFeature(capabilities, "logs.body.tokenbf")) return "tokenbf"
	return "scan"
}
