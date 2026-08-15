// The versioned dashboard document schema — the single source of truth for the
// shape of a dashboard, shared by the API, the web and mobile clients, the MCP
// tools, the templates and the IaC provider.
//
// Layout:
//   shared/   version-independent leaves, plus the two factories for the nodes
//             that straddle a version boundary (`display` embeds a data source
//             via `sparkline`, and the document embeds a widget)
//   v1/       the shape every pre-versioning document is stored in, frozen
//   index.ts  unsuffixed aliases bound to the current version
//
// Consumers import the unsuffixed names and follow whatever the current version
// is. Reach for a version-suffixed name only when you specifically mean that
// version — a migration step, or a test asserting a legacy document still reads.

export {
	DASHBOARD_MIGRATIONS,
	type DashboardMigration,
	detectSchemaVersion,
	migrateToLatest,
} from "./migrations"
export {
	dataSourceEndpoint,
	dataSourceQuerySet,
	dataSourceRawSql,
	dataSourceRouteParams,
	dataSourceTransform,
	isQueryDataSource,
	QUERY_RESULT_ENDPOINTS,
	RAW_SQL_ENDPOINT,
	type RawSqlDataSource,
	type WidgetQuerySet,
} from "./access"
export {
	makeQueryDataSource,
	makeRawSqlDataSource,
	makeRouteDataSource,
	makeStaticDataSource,
	type QueryDataSourceInput,
	type RawSqlDataSourceInput,
} from "./construct"
// v3 — what the unsuffixed aliases below now point at. The suffixed names stay
// exported for the upgrade transform and its tests, which must name a version
// explicitly.
export {
	QueryWidgetDataSource,
	RawSqlWidgetDataSource,
	RouteWidgetDataSource,
	StaticWidgetDataSource,
	WIDGET_DATA_SOURCE_KINDS,
	type WidgetDataSourceKind,
	WidgetDataSourceV3,
} from "./v3/data-source"
export { DashboardDocumentV3, PortableDashboardDocumentV3 } from "./v3/document"
export { DashboardWidgetV3, WidgetDisplayConfigV3 } from "./v3/widget"
export { MARKDOWN_STATIC_ENDPOINT, QUERY_ENDPOINT_RESULT_KINDS } from "./legacy-endpoints"
// The one-shot upgrade the backfill script runs against Postgres. Deliberately
// not a `DashboardMigration` — see the header of `upgrade-to-v3.ts`.
export {
	fromLegacyDataSource,
	isDocumentV3,
	isV3DataSource,
	upgradeDocumentToV3,
	upgradeStoredDocument,
} from "./upgrade-to-v3"
export { type DashboardParseOutcome, parseStoredDashboard, stampCurrentVersion } from "./parse"
export { CURRENT_DASHBOARD_SCHEMA_VERSION, DashboardSchemaVersion } from "./version"
export { makeWidgetDisplayConfigSchema } from "./shared/display"
export { WidgetLayoutSchema } from "./shared/layout"
export {
	DASHBOARD_MAX_SECTIONS,
	DASHBOARD_MAX_TABS_PER_SECTION,
	type DashboardSection,
	DashboardSectionSchema,
	type DashboardSectionTab,
	DashboardSectionTabSchema,
} from "./shared/sections"
export { type TimeRange, TimeRangeSchema } from "./shared/time-range"
export {
	SORT_DIRECTIONS,
	type SortDirection,
	STAT_AGGREGATES,
	type StatAggregate,
	WidgetDataSourceTransformV2 as WidgetDataSourceTransformSchema,
} from "./shared/transform"
// These four are each a const *and* a type of the same name; re-exporting the
// bare name carries both meanings, which is what consumers rely on.
export {
	DashboardQueryVariableFacet,
	type DashboardQueryVariableSource,
	DashboardQueryVariableSourceSchema,
	DashboardRefreshIntervalSeconds,
	type DashboardVariable,
	DashboardVariableName,
	DashboardVariableSchema,
} from "./shared/variables"

// Current-version aliases. When a version is added, these move to it and every
// consumer follows without an import change.
//
// Documents are re-exported under a new name rather than subclassed: decoding
// through a subclass of a `Schema.Class` still constructs the *parent*, so
// `instanceof` on a decoded value would be false.
export {
	DashboardDocumentV3 as DashboardDocument,
	PortableDashboardDocumentV3 as PortableDashboardDocument,
} from "./v3/document"
export { withWidgets } from "./document-helpers"
export { DASHBOARD_GRID_COLS, findNextPosition, type PlaceableWidget } from "./placement"
export { DashboardDocumentV2 } from "./v2/document"
export { WidgetDataSourceV3 as WidgetDataSourceSchema } from "./v3/data-source"
export { WidgetDisplayConfigV3 as WidgetDisplayConfigSchema } from "./v3/widget"
export { DashboardWidgetV3 as DashboardWidgetSchema } from "./v3/widget"

// Section helpers: pure placement/repair logic shared by the API write path,
// the web read path and the tests.
export * from "./sections-helpers"
