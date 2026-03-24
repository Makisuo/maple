import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { DashboardId, IsoDateTimeString } from "../primitives"
import { Authorization } from "./current-tenant"

const TimeRangeSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("relative"),
    value: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("absolute"),
    startTime: IsoDateTimeString,
    endTime: IsoDateTimeString,
  }),
])

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)
const StringRecord = Schema.Record(Schema.String, Schema.String)

const WidgetDataSourceSchema = Schema.Struct({
  endpoint: Schema.String,
  params: Schema.optional(UnknownRecord),
  transform: Schema.optional(
    Schema.Struct({
      fieldMap: Schema.optional(StringRecord),
      flattenSeries: Schema.optional(
        Schema.Struct({
          valueField: Schema.String,
        }),
      ),
      reduceToValue: Schema.optional(
        Schema.Struct({
          field: Schema.String,
          aggregate: Schema.optional(Schema.String),
        }),
      ),
      computeRatio: Schema.optional(
        Schema.Struct({
          numeratorName: Schema.String,
          denominatorNames: Schema.Array(Schema.String),
        }),
      ),
      limit: Schema.optional(Schema.Number),
      sortBy: Schema.optional(
        Schema.Struct({
          field: Schema.String,
          direction: Schema.String,
        }),
      ),
    }),
  ),
})

const WidgetDisplayColumnSchema = Schema.Struct({
  field: Schema.String,
  header: Schema.String,
  unit: Schema.optional(Schema.String),
  width: Schema.optional(Schema.Number),
  align: Schema.optional(Schema.String),
})

const WidgetDisplayConfigSchema = Schema.Struct({
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  chartId: Schema.optional(Schema.String),
  chartPresentation: Schema.optional(
    Schema.Struct({
      legend: Schema.optional(Schema.String),
      tooltip: Schema.optional(Schema.String),
    }),
  ),
  xAxis: Schema.optional(
    Schema.Struct({
      label: Schema.optional(Schema.String),
      unit: Schema.optional(Schema.String),
      visible: Schema.optional(Schema.Boolean),
    }),
  ),
  yAxis: Schema.optional(
    Schema.Struct({
      label: Schema.optional(Schema.String),
      unit: Schema.optional(Schema.String),
      min: Schema.optional(Schema.Number),
      max: Schema.optional(Schema.Number),
      visible: Schema.optional(Schema.Boolean),
    }),
  ),
  seriesMapping: Schema.optional(StringRecord),
  colorOverrides: Schema.optional(StringRecord),
  stacked: Schema.optional(Schema.Boolean),
  curveType: Schema.optional(Schema.String),
  unit: Schema.optional(Schema.String),
  thresholds: Schema.optional(
    Schema.Array(
      Schema.Struct({
        value: Schema.Number,
        color: Schema.String,
        label: Schema.optional(Schema.String),
      }),
    ),
  ),
  prefix: Schema.optional(Schema.String),
  suffix: Schema.optional(Schema.String),
  sparkline: Schema.optional(
    Schema.Struct({
      enabled: Schema.Boolean,
      dataSource: Schema.optional(WidgetDataSourceSchema),
    }),
  ),
  columns: Schema.optional(Schema.Array(WidgetDisplayColumnSchema)),
})

const WidgetLayoutSchema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  w: Schema.Number,
  h: Schema.Number,
  minW: Schema.optional(Schema.Number),
  minH: Schema.optional(Schema.Number),
  maxW: Schema.optional(Schema.Number),
  maxH: Schema.optional(Schema.Number),
})

const DashboardWidgetSchema = Schema.Struct({
  id: Schema.String,
  visualization: Schema.String,
  dataSource: WidgetDataSourceSchema,
  display: WidgetDisplayConfigSchema,
  layout: WidgetLayoutSchema,
})

export class PortableDashboardDocument extends Schema.Class<PortableDashboardDocument>("PortableDashboardDocument")({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  timeRange: TimeRangeSchema,
  widgets: Schema.Array(DashboardWidgetSchema),
}) {}

export class DashboardDocument extends Schema.Class<DashboardDocument>("DashboardDocument")({
  id: DashboardId,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  timeRange: TimeRangeSchema,
  variables: Schema.optional(Schema.Array(Schema.Unknown)),
  widgets: Schema.Array(DashboardWidgetSchema),
  createdAt: IsoDateTimeString,
  updatedAt: IsoDateTimeString,
}) {}

export class DashboardsListResponse extends Schema.Class<DashboardsListResponse>("DashboardsListResponse")({
  dashboards: Schema.Array(DashboardDocument),
}) {}

export class DashboardUpsertRequest extends Schema.Class<DashboardUpsertRequest>("DashboardUpsertRequest")({
  dashboard: DashboardDocument,
}) {}

export class DashboardCreateRequest extends Schema.Class<DashboardCreateRequest>("DashboardCreateRequest")({
  dashboard: PortableDashboardDocument,
}) {}

export class DashboardDeleteResponse extends Schema.Class<DashboardDeleteResponse>("DashboardDeleteResponse")({
  id: DashboardId,
}) {}

export class DashboardPersistenceError extends Schema.TaggedErrorClass<DashboardPersistenceError>()(
  "DashboardPersistenceError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {}

export class DashboardNotFoundError extends Schema.TaggedErrorClass<DashboardNotFoundError>()(
  "DashboardNotFoundError",
  {
    dashboardId: DashboardId,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class DashboardValidationError extends Schema.TaggedErrorClass<DashboardValidationError>()(
  "DashboardValidationError",
  {
    message: Schema.String,
    details: Schema.Array(Schema.String),
  },
  { httpApiStatus: 400 },
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
      error: [DashboardValidationError, DashboardPersistenceError],
    }),
  )
  .add(
    HttpApiEndpoint.put("upsert", "/:dashboardId", {
      params: {
        dashboardId: DashboardId,
      },
      payload: DashboardUpsertRequest,
      success: DashboardDocument,
      error: [DashboardValidationError, DashboardPersistenceError],
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
  .prefix("/api/dashboards")
  .middleware(Authorization) {}
