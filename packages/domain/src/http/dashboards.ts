import { Schema } from "effect"
import { DashboardDocument, PortableDashboardDocument } from "@maple/widgets/dashboard"
import {
	DashboardId,
	DashboardTemplateCategory,
	DashboardTemplateId,
	DashboardTemplateParameterKey,
	DashboardVersionId,
	IsoDateTimeString,
	PostgresTransactionId,
	UserId,
} from "../primitives"
import { HttpTaggedError } from "./error-policy"

// The dashboard *document* schema lives in `../dashboard`, which is versioned.
// This module keeps the HTTP request/response envelopes and tagged errors. The
// v1 endpoint group that used to live here is gone — `/v2/dashboards` replaced
// it — but the v2 contract and the dashboard services still import these types.
//
// Every document-shape name is re-exported below so importing from
// `@maple/domain/http` keeps working unchanged. New code should prefer
// `@maple/domain/dashboard`.
export {
	DASHBOARD_MAX_SECTIONS,
	DASHBOARD_MAX_TABS_PER_SECTION,
	DashboardDocument,
	DashboardQueryVariableFacet,
	type DashboardQueryVariableSource,
	DashboardQueryVariableSourceSchema,
	DashboardRefreshIntervalSeconds,
	type DashboardSection,
	DashboardSectionSchema,
	type DashboardSectionTab,
	DashboardSectionTabSchema,
	type DashboardVariable,
	DashboardVariableName,
	DashboardVariableSchema,
	DashboardWidgetSchema,
	DASHBOARD_GRID_COLS,
	findNextPosition,
	isWidgetUnit,
	// Any reader that decodes a *stored* payload must migrate it first: a
	// document is only stamped with the current schema version at its next write,
	// so Electric hands the browser whatever version it was last written in.
	migrateToLatest,
	PortableDashboardDocument,
	STAT_AGGREGATES,
	type StatAggregate,
	suggestWidgetUnit,
	type TimeRange,
	TimeRangeSchema,
	WIDGET_UNIT_TOKENS,
	WIDGET_UNITS,
	WidgetDataSourceSchema,
	WidgetDisplayConfigSchema,
	type WidgetUnitMeta,
	WidgetLayoutSchema,
	withWidgets,
} from "@maple/widgets/dashboard"

export class DashboardsListResponse extends Schema.Class<DashboardsListResponse>("DashboardsListResponse")({
	dashboards: Schema.Array(DashboardDocument),
}) {}

export class DashboardUpsertRequest extends Schema.Class<DashboardUpsertRequest>("DashboardUpsertRequest")(
	{ dashboard: DashboardDocument },
	{ parseOptions: { reportInput: true } },
) {}

export class DashboardCreateRequest extends Schema.Class<DashboardCreateRequest>("DashboardCreateRequest")(
	{ dashboard: PortableDashboardDocument },
	{ parseOptions: { reportInput: true } },
) {}

export class DashboardPersesImportRequest extends Schema.Class<DashboardPersesImportRequest>(
	"DashboardPersesImportRequest",
)({
	dashboard: Schema.Record(Schema.String, Schema.Unknown),
}) {}

export class DashboardPersesImportResponse extends Schema.Class<DashboardPersesImportResponse>(
	"DashboardPersesImportResponse",
)({
	dashboard: DashboardDocument,
	warnings: Schema.Array(Schema.String),
	// Txid of the import write, for the Electric collection's onInsert handler.
	txid: Schema.optionalKey(PostgresTransactionId),
}) {}

export class DashboardDeleteResponse extends Schema.Class<DashboardDeleteResponse>("DashboardDeleteResponse")(
	{
		id: DashboardId,
		// Txid of the delete, for the Electric collection's onDelete handler.
		txid: Schema.optionalKey(PostgresTransactionId),
	},
) {}

// Versions / history

export const DashboardVersionChangeKind = Schema.Literals([
	"created",
	"renamed",
	"description_changed",
	"tags_changed",
	"time_range_changed",
	"variables_changed",
	"refresh_interval_changed",
	"widget_added",
	"widget_removed",
	"widget_updated",
	"layout_changed",
	// Section edits collapse into three kinds. Renames, tab add/rename/delete,
	// reordering and the stored collapse default all read as `section_updated`:
	// the history panel shows a summary line, not a structural diff, so finer
	// granularity would add enum members nothing renders differently. Moving a
	// widget between sections is `layout_changed` — it genuinely is a layout act.
	"section_added",
	"section_removed",
	"section_updated",
	"restored",
	"multiple",
]).annotate({
	identifier: "@maple/DashboardVersionChangeKind",
	title: "Dashboard Version Change Kind",
})
export type DashboardVersionChangeKind = Schema.Schema.Type<typeof DashboardVersionChangeKind>

export class DashboardVersionSummary extends Schema.Class<DashboardVersionSummary>("DashboardVersionSummary")(
	{
		id: DashboardVersionId,
		dashboardId: DashboardId,
		versionNumber: Schema.Number,
		changeKind: DashboardVersionChangeKind,
		changeSummary: Schema.NullOr(Schema.String),
		sourceVersionId: Schema.NullOr(DashboardVersionId),
		createdAt: IsoDateTimeString,
		createdBy: UserId,
	},
) {}

export class DashboardVersionDetail extends Schema.Class<DashboardVersionDetail>("DashboardVersionDetail")({
	id: DashboardVersionId,
	dashboardId: DashboardId,
	versionNumber: Schema.Number,
	changeKind: DashboardVersionChangeKind,
	changeSummary: Schema.NullOr(Schema.String),
	sourceVersionId: Schema.NullOr(DashboardVersionId),
	createdAt: IsoDateTimeString,
	createdBy: UserId,
	snapshot: DashboardDocument,
}) {}

export class DashboardVersionsListResponse extends Schema.Class<DashboardVersionsListResponse>(
	"DashboardVersionsListResponse",
)({
	versions: Schema.Array(DashboardVersionSummary),
	hasMore: Schema.Boolean,
}) {}

export class DashboardVersionNotFoundError extends HttpTaggedError<DashboardVersionNotFoundError>()(
	"@maple/http/errors/DashboardVersionNotFoundError",
	{
		dashboardId: DashboardId,
		versionId: DashboardVersionId,
		message: Schema.String,
	},
	{
		status: 404,
		code: "dashboard_version_not_found",
		title: "Dashboard version not found",
		message: "No such dashboard version.",
		param: "version_id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export class DashboardPersistenceError extends HttpTaggedError<DashboardPersistenceError>()(
	"@maple/http/errors/DashboardPersistenceError",
	{
		message: Schema.String,
	},
	{
		status: 503,
		code: "dashboards_unavailable",
		title: "Dashboards are temporarily unavailable",
		message: "Dashboards are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

/** A saved dashboard or version snapshot no longer decodes as a Maple dashboard document. */
export class DashboardStoredConfigInvalidError extends HttpTaggedError<DashboardStoredConfigInvalidError>()(
	"@maple/http/errors/DashboardStoredConfigInvalidError",
	{
		message: Schema.String,
		dashboardId: DashboardId,
		component: Schema.Literals(["document", "version_snapshot"]),
		versionId: Schema.optionalKey(DashboardVersionId),
		cause: Schema.Defect(),
	},
	{
		status: 500,
		code: "dashboard_stored_config_invalid",
		title: "Stored dashboard is invalid",
		message: "The stored dashboard configuration could not be read.",
		retry: "never",
		recovery: "contact_support",
		exposure: "redacted",
	},
) {}

export class DashboardNotFoundError extends HttpTaggedError<DashboardNotFoundError>()(
	"@maple/http/errors/DashboardNotFoundError",
	{
		dashboardId: DashboardId,
		message: Schema.String,
	},
	{
		status: 404,
		code: "dashboard_not_found",
		title: "Dashboard not found",
		message: "No such dashboard.",
		param: "id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export class DashboardValidationError extends HttpTaggedError<DashboardValidationError>()(
	"@maple/http/errors/DashboardValidationError",
	{
		message: Schema.String,
		details: Schema.Array(Schema.String),
	},
	{
		status: 400,
		code: "dashboard_invalid",
		title: "Invalid dashboard",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

export class DashboardConcurrencyError extends HttpTaggedError<DashboardConcurrencyError>()(
	"@maple/http/errors/DashboardConcurrencyError",
	{
		dashboardId: DashboardId,
		message: Schema.String,
	},
	{
		status: 409,
		code: "dashboard_concurrent_update",
		title: "Dashboard changed while saving",
		retry: "never",
		recovery: "refresh",
		exposure: "public_message",
	},
) {}

// Templates

export class DashboardTemplateParameter extends Schema.Class<DashboardTemplateParameter>(
	"DashboardTemplateParameter",
)({
	key: DashboardTemplateParameterKey,
	label: Schema.String,
	description: Schema.String,
	required: Schema.Boolean,
	placeholder: Schema.optionalKey(Schema.String),
}) {}

/**
 * Panel type of a widget in a template thumbnail. Mirrors `PanelType` in
 * `./widget-types` — spelled out here because the API surface is a wire schema,
 * not a derived one, so widening it stays a deliberate, reviewable edit.
 */
export const DashboardTemplatePreviewKind = Schema.Literals([
	"line",
	"area",
	"bar",
	"stat",
	"gauge",
	"table",
	"list",
	"pie",
	"histogram",
	"heatmap",
	"funnel",
	"hbar",
	"markdown",
])
export type DashboardTemplatePreviewKind = typeof DashboardTemplatePreviewKind.Type

export class DashboardTemplatePreviewWidget extends Schema.Class<DashboardTemplatePreviewWidget>(
	"DashboardTemplatePreviewWidget",
)({
	x: Schema.Number,
	y: Schema.Number,
	w: Schema.Number,
	h: Schema.Number,
	kind: DashboardTemplatePreviewKind,
	title: Schema.String,
}) {}

export const DashboardTemplateRequirementKind = Schema.Literals(["metrics", "integration", "telemetry"])
export type DashboardTemplateRequirementKind = typeof DashboardTemplateRequirementKind.Type

/**
 * What an org needs before a template's widgets have anything to draw. The
 * picker states it twice at different lengths — `missing` next to the template
 * name, `collector` in the detail panel — so neither has to be recovered from
 * prose by the client.
 */
export const DashboardTemplateRequirement = Schema.Struct({
	kind: DashboardTemplateRequirementKind,
	/** Full prose; the same string the `requirements` array carries. */
	label: Schema.String,
	/**
	 * Row-sized statement of what's missing ("not connected"). Absent for
	 * `metrics`, where clients derive `no <prefix>*` from
	 * `requiredMetricPrefixes`.
	 */
	missing: Schema.optionalKey(Schema.String),
	/** Noun phrase read as "Collected by {collector}." */
	collector: Schema.String,
	/** Noun phrase read as "Set up {setupLabel}". Absent for `telemetry`. */
	setupLabel: Schema.optionalKey(Schema.String),
	/** One extra sentence shown when the template is gated. */
	hint: Schema.optionalKey(Schema.String),
})
export type DashboardTemplateRequirement = typeof DashboardTemplateRequirement.Type

export class DashboardTemplateMetadata extends Schema.Class<DashboardTemplateMetadata>(
	"DashboardTemplateMetadata",
)({
	id: DashboardTemplateId,
	name: Schema.String,
	description: Schema.String,
	category: DashboardTemplateCategory,
	tags: Schema.Array(Schema.String),
	/** Derived from `requirement.label`. Empty for the blank template. */
	requirements: Schema.Array(Schema.String),
	/** Null only for the blank template, which needs nothing. */
	requirement: Schema.NullOr(DashboardTemplateRequirement),
	/**
	 * Metric-name prefixes the template's widgets query; the picker greys out
	 * templates whose prefixes match none of the org's metrics. Empty array =
	 * never gated. An empty-string prefix means "any metric".
	 */
	requiredMetricPrefixes: Schema.Array(Schema.String),
	parameters: Schema.Array(DashboardTemplateParameter),
	preview: Schema.Array(DashboardTemplatePreviewWidget),
}) {}

export class DashboardTemplatesListResponse extends Schema.Class<DashboardTemplatesListResponse>(
	"DashboardTemplatesListResponse",
)({
	templates: Schema.Array(DashboardTemplateMetadata),
}) {}

export class DashboardTemplateInstantiateRequest extends Schema.Class<DashboardTemplateInstantiateRequest>(
	"DashboardTemplateInstantiateRequest",
)({
	parameters: Schema.optionalKey(Schema.Record(DashboardTemplateParameterKey, Schema.String)),
	name: Schema.optionalKey(Schema.String),
}) {}

export class DashboardTemplateNotFoundError extends HttpTaggedError<DashboardTemplateNotFoundError>()(
	"@maple/http/errors/DashboardTemplateNotFoundError",
	{
		templateId: DashboardTemplateId,
		message: Schema.String,
	},
	{
		status: 404,
		code: "dashboard_template_not_found",
		title: "Dashboard template not found",
		message: "No such dashboard template.",
		param: "template_id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}
