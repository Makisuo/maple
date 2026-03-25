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
  params: Schema.optionalKey(UnknownRecord),
  transform: Schema.optionalKey(
    Schema.Struct({
      fieldMap: Schema.optionalKey(StringRecord),
      flattenSeries: Schema.optionalKey(
        Schema.Struct({
          valueField: Schema.String,
        }),
      ),
      reduceToValue: Schema.optionalKey(
        Schema.Struct({
          field: Schema.String,
          aggregate: Schema.optionalKey(Schema.String),
        }),
      ),
      computeRatio: Schema.optionalKey(
        Schema.Struct({
          numeratorName: Schema.String,
          denominatorNames: Schema.Array(Schema.String),
        }),
      ),
      limit: Schema.optionalKey(Schema.Number),
      sortBy: Schema.optionalKey(
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
  unit: Schema.optionalKey(Schema.String),
  width: Schema.optionalKey(Schema.Number),
  align: Schema.optionalKey(Schema.String),
})

const WidgetDisplayConfigSchema = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  chartId: Schema.optionalKey(Schema.String),
  chartPresentation: Schema.optionalKey(
    Schema.Struct({
      legend: Schema.optionalKey(Schema.String),
      tooltip: Schema.optionalKey(Schema.String),
    }),
  ),
  xAxis: Schema.optionalKey(
    Schema.Struct({
      label: Schema.optionalKey(Schema.String),
      unit: Schema.optionalKey(Schema.String),
      visible: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  yAxis: Schema.optionalKey(
    Schema.Struct({
      label: Schema.optionalKey(Schema.String),
      unit: Schema.optionalKey(Schema.String),
      min: Schema.optionalKey(Schema.Number),
      max: Schema.optionalKey(Schema.Number),
      visible: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  seriesMapping: Schema.optionalKey(StringRecord),
  colorOverrides: Schema.optionalKey(StringRecord),
  stacked: Schema.optionalKey(Schema.Boolean),
  curveType: Schema.optionalKey(Schema.String),
  unit: Schema.optionalKey(Schema.String),
  thresholds: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        value: Schema.Number,
        color: Schema.String,
        label: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  prefix: Schema.optionalKey(Schema.String),
  suffix: Schema.optionalKey(Schema.String),
  sparkline: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.Boolean,
      dataSource: Schema.optionalKey(WidgetDataSourceSchema),
    }),
  ),
  columns: Schema.optionalKey(Schema.Array(WidgetDisplayColumnSchema)),
})

const WidgetLayoutSchema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  w: Schema.Number,
  h: Schema.Number,
  minW: Schema.optionalKey(Schema.Number),
  minH: Schema.optionalKey(Schema.Number),
  maxW: Schema.optionalKey(Schema.Number),
  maxH: Schema.optionalKey(Schema.Number),
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
  description: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  timeRange: TimeRangeSchema,
  widgets: Schema.Array(DashboardWidgetSchema),
}) {}

export class DashboardDocument extends Schema.Class<DashboardDocument>("DashboardDocument")({
  id: DashboardId,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  timeRange: TimeRangeSchema,
  variables: Schema.optionalKey(Schema.Array(Schema.Unknown)),
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
