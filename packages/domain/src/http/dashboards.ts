import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/unstable/httpapi"
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
import { Authorization } from "./current-tenant"

// The dashboard *document* schema lives in `../dashboard`, which is versioned.
// This module keeps the HTTP surface: request/response envelopes, tagged errors
// and the endpoint group — all of which reference the `Authorization` middleware
// and so must stay under `http/` to keep `http/api.ts` acyclic.
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
	PortableDashboardDocument,
	type TimeRange,
	TimeRangeSchema,
	WidgetDataSourceSchema,
	WidgetDisplayConfigSchema,
	WidgetLayoutSchema,
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

const DashboardVersionsListQuery = Schema.Struct({
	limit: Schema.optional(
		Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 200 })),
	),
	before: Schema.optional(Schema.NumberFromString.check(Schema.isInt())),
})

export class DashboardVersionNotFoundError extends Schema.TaggedError<DashboardVersionNotFoundError>()(
	"@maple/http/errors/DashboardVersionNotFoundError",
	{
		dashboardId: DashboardId,
		versionId: DashboardVersionId,
		message: Schema.String,
	},
	{ httpApiStatus: 404 },
) {}

export class DashboardPersistenceError extends Schema.TaggedError<DashboardPersistenceError>()(
	"@maple/http/errors/DashboardPersistenceError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 503 },
) {}

export class DashboardNotFoundError extends Schema.TaggedError<DashboardNotFoundError>()(
	"@maple/http/errors/DashboardNotFoundError",
	{
		dashboardId: DashboardId,
		message: Schema.String,
	},
	{ httpApiStatus: 404 },
) {}

export class DashboardValidationError extends Schema.TaggedError<DashboardValidationError>()(
	"@maple/http/errors/DashboardValidationError",
	{
		message: Schema.String,
		details: Schema.Array(Schema.String),
	},
	{ httpApiStatus: 400 },
) {}

/**
 * Rewrites request-decode failures on the dashboards group into a
 * `DashboardValidationError` carrying the JSON path, the enclosing widget id
 * and the expected-vs-received message for every offending field.
 *
 * Without it the runtime answers a schema failure with a bare empty 400, so the
 * only way to find one bad key in a 14-widget document is to bisect it. The
 * error class is already in every endpoint's error list, so attaching this
 * widens no client contract.
 */
export class DashboardSchemaErrors extends HttpApiMiddleware.Service<DashboardSchemaErrors>()(
	"DashboardSchemaErrors",
	{ error: DashboardValidationError },
) {}

export class DashboardConcurrencyError extends Schema.TaggedError<DashboardConcurrencyError>()(
	"@maple/http/errors/DashboardConcurrencyError",
	{
		dashboardId: DashboardId,
		message: Schema.String,
	},
	{ httpApiStatus: 409 },
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

export class DashboardTemplateNotFoundError extends Schema.TaggedError<DashboardTemplateNotFoundError>()(
	"@maple/http/errors/DashboardTemplateNotFoundError",
	{
		templateId: DashboardTemplateId,
		message: Schema.String,
	},
	{ httpApiStatus: 404 },
) {}

export class DashboardsApiGroup extends HttpApiGroup.make("dashboards")
	.add(
		HttpApiEndpoint.get("list", "/", {
			success: DashboardsListResponse,
			error: DashboardPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: DashboardCreateRequest,
			success: DashboardDocument,
			error: [DashboardValidationError, DashboardPersistenceError, DashboardConcurrencyError],
		}),
	)
	.add(
		HttpApiEndpoint.post("importPerses", "/import/perses", {
			payload: DashboardPersesImportRequest,
			success: DashboardPersesImportResponse,
			error: [DashboardValidationError, DashboardPersistenceError, DashboardConcurrencyError],
		}),
	)
	.add(
		HttpApiEndpoint.put("upsert", "/:dashboardId", {
			params: {
				dashboardId: DashboardId,
			},
			payload: DashboardUpsertRequest,
			success: DashboardDocument,
			error: [
				DashboardValidationError,
				DashboardPersistenceError,
				DashboardConcurrencyError,
				DashboardNotFoundError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:dashboardId", {
			params: {
				dashboardId: DashboardId,
			},
			success: DashboardDeleteResponse,
			error: [DashboardNotFoundError, DashboardPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.get("listVersions", "/:dashboardId/versions", {
			params: { dashboardId: DashboardId },
			query: DashboardVersionsListQuery,
			success: DashboardVersionsListResponse,
			error: [DashboardNotFoundError, DashboardPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.get("getVersion", "/:dashboardId/versions/:versionId", {
			params: { dashboardId: DashboardId, versionId: DashboardVersionId },
			success: DashboardVersionDetail,
			error: [DashboardNotFoundError, DashboardVersionNotFoundError, DashboardPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.post("restoreVersion", "/:dashboardId/versions/:versionId/restore", {
			params: { dashboardId: DashboardId, versionId: DashboardVersionId },
			success: DashboardDocument,
			error: [
				DashboardNotFoundError,
				DashboardVersionNotFoundError,
				DashboardValidationError,
				DashboardPersistenceError,
				DashboardConcurrencyError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.get("listTemplates", "/templates", {
			success: DashboardTemplatesListResponse,
		}),
	)
	.add(
		HttpApiEndpoint.post("instantiateTemplate", "/templates/:templateId/instantiate", {
			params: { templateId: DashboardTemplateId },
			payload: DashboardTemplateInstantiateRequest,
			success: DashboardDocument,
			error: [
				DashboardTemplateNotFoundError,
				DashboardValidationError,
				DashboardPersistenceError,
				DashboardConcurrencyError,
			],
		}),
	)
	.prefix("/api/dashboards")
	.middleware(Authorization)
	.middleware(DashboardSchemaErrors) {}
