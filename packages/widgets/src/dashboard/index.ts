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
export { WidgetDataSourceTransformSchema } from "./shared/transform"
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
	DashboardDocumentV1 as DashboardDocument,
	PortableDashboardDocumentV1 as PortableDashboardDocument,
} from "./v1/document"
export { WidgetDataSourceV1 as WidgetDataSourceSchema } from "./v1/data-source"
export { WidgetDisplayConfigV1 as WidgetDisplayConfigSchema } from "./v1/widget"
export { DashboardWidgetV1 as DashboardWidgetSchema } from "./v1/widget"

// Section helpers: pure placement/repair logic shared by the API write path,
// the web read path and the tests.
export * from "./sections-helpers"
