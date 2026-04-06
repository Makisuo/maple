// ---------------------------------------------------------------------------
// Typed Error Queries
//
// DSL-based query definitions for error aggregation and timeseries.
// ---------------------------------------------------------------------------

import * as CH from "../expr"
import { param } from "../param"
import { from, fromQuery, type ColumnAccessor } from "../query"
import { unionAll, type CHUnionQuery } from "../union"
import { compileCH } from "../compile"
import { ErrorSpans, ServiceUsage, TraceListMv, Traces } from "../tables"

// ---------------------------------------------------------------------------
// Shared: Error fingerprint expression (typed DSL)
// ---------------------------------------------------------------------------

/** Extracts a short error "type" from StatusMessage for grouping. */
export function errorFingerprint(statusMessage: CH.Expr<string>): CH.Expr<string> {
  return CH.if_(
    statusMessage.eq(""),
    CH.lit("Unknown Error"),
    CH.left_(
      statusMessage,
      CH.multiIf(
        [
          [CH.position_(statusMessage, ": ").gt(3), CH.toInt64(CH.position_(statusMessage, ": ")).sub(1)],
          [CH.position_(statusMessage, " (").gt(3), CH.toInt64(CH.position_(statusMessage, " (")).sub(1)],
          [CH.position_(statusMessage, "\\n").gt(3), CH.toInt64(CH.position_(statusMessage, "\\n")).sub(1)],
          [CH.position_(statusMessage, "{").gt(10), CH.toInt64(CH.position_(statusMessage, "{")).sub(1)],
        ],
        CH.least_(CH.toInt64(CH.length_(statusMessage)), CH.lit(150)),
      ),
    ),
  )
}


// ---------------------------------------------------------------------------
// Errors by type
// ---------------------------------------------------------------------------

export interface ErrorsByTypeOpts {
  rootOnly?: boolean
  services?: readonly string[]
  deploymentEnvs?: readonly string[]
  errorTypes?: readonly string[]
  limit?: number
}

export interface ErrorsByTypeOutput {
  readonly errorType: string
  readonly sampleMessage: string
  readonly count: number
  readonly affectedServicesCount: number
  readonly firstSeen: string
  readonly lastSeen: string
}

export function errorsByTypeQuery(
  opts: ErrorsByTypeOpts,
) {
  return from(ErrorSpans)
    .select(($) => ({
      errorType: errorFingerprint($.StatusMessage),
      sampleMessage: CH.any_($.StatusMessage),
      count: CH.count(),
      affectedServicesCount: CH.uniq($.ServiceName),
      firstSeen: CH.min_($.Timestamp),
      lastSeen: CH.max_($.Timestamp),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
      CH.whenTrue(!!opts.rootOnly, () => $.ParentSpanId.eq("")),
      opts.services?.length
        ? CH.inList($.ServiceName, opts.services)
        : undefined,
      opts.deploymentEnvs?.length
        ? CH.inList($.DeploymentEnv, opts.deploymentEnvs)
        : undefined,
      opts.errorTypes?.length
        ? CH.inList(errorFingerprint($.StatusMessage), opts.errorTypes)
        : undefined,
    ])
    .groupBy("errorType")
    .orderBy(["count", "desc"])
    .limit(opts.limit ?? 50)
    .format("JSON")
}

// ---------------------------------------------------------------------------
// Errors timeseries
// ---------------------------------------------------------------------------

export interface ErrorsTimeseriesOpts {
  errorType: string
  services?: readonly string[]
}

export interface ErrorsTimeseriesOutput {
  readonly bucket: string
  readonly count: number
}

export function errorsTimeseriesQuery(
  opts: ErrorsTimeseriesOpts,
) {
  return from(ErrorSpans)
    .select(($) => ({
      bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
      count: CH.count(),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      errorFingerprint($.StatusMessage).eq(opts.errorType),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
      opts.services?.length
        ? CH.inList($.ServiceName, opts.services)
        : undefined,
    ])
    .groupBy("bucket")
    .orderBy(["bucket", "asc"])
    .format("JSON")
}

// ---------------------------------------------------------------------------
// Span hierarchy
// ---------------------------------------------------------------------------

export interface SpanHierarchyOpts {
  traceId: string
  spanId?: string
}

export interface SpanHierarchyOutput {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string
  readonly spanName: string
  readonly serviceName: string
  readonly spanKind: string
  readonly durationMs: number
  readonly startTime: string
  readonly statusCode: string
  readonly statusMessage: string
  readonly spanAttributes: string
  readonly resourceAttributes: string
  readonly relationship: string
}

export function spanHierarchyQuery(
  opts: SpanHierarchyOpts,
) {
  return from(Traces)
    .select(($) => {
      // HTTP span name rewriting: "http.server GET" + route → "GET /api/users"
      const route = $.SpanAttributes.get("http.route")
      const urlPath = $.SpanAttributes.get("url.path")
      const httpRewriteExpr = CH.if_(
        $.SpanName.like("http.server %")
          .or($.SpanName.in_("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"))
          .and(route.neq("").or(urlPath.neq(""))),
        CH.concat(
          CH.if_($.SpanName.like("http.server %"), CH.replaceOne($.SpanName, "http.server ", ""), $.SpanName),
          CH.lit(" "),
          CH.if_(route.neq(""), route, urlPath),
        ),
        $.SpanName,
      )

      const relationshipExpr = opts.spanId
        ? CH.if_($.SpanId.eq(opts.spanId), CH.lit("target"), CH.lit("related"))
        : CH.lit("related")

      return {
        traceId: $.TraceId,
        spanId: $.SpanId,
        parentSpanId: $.ParentSpanId,
        spanName: httpRewriteExpr,
        serviceName: $.ServiceName,
        spanKind: $.SpanKind,
        durationMs: $.Duration.div(1000000),
        startTime: $.Timestamp,
        statusCode: $.StatusCode,
        statusMessage: $.StatusMessage,
        spanAttributes: CH.toJSONString($.SpanAttributes),
        resourceAttributes: CH.toJSONString($.ResourceAttributes),
        relationship: relationshipExpr,
      }
    })
    .where(($) => [
      $.TraceId.eq(opts.traceId),
      $.OrgId.eq(param.string("orgId")),
    ])
    .orderBy(["startTime", "asc"])
    .format("JSON")
}

// ---------------------------------------------------------------------------
// Traces duration stats
// ---------------------------------------------------------------------------

export interface TracesDurationStatsOpts {
  serviceName?: string
  spanName?: string
  hasError?: boolean
  minDurationMs?: number
  maxDurationMs?: number
  httpMethod?: string
  httpStatusCode?: string
  deploymentEnv?: string
  matchModes?: {
    serviceName?: "contains"
    spanName?: "contains"
    deploymentEnv?: "contains"
  }
}

export interface TracesDurationStatsOutput {
  readonly minDurationMs: number
  readonly maxDurationMs: number
  readonly p50DurationMs: number
  readonly p95DurationMs: number
}

export function tracesDurationStatsQuery(
  opts: TracesDurationStatsOpts,
) {
  const mm = opts.matchModes

  return from(TraceListMv)
    .select(($) => ({
      minDurationMs: CH.min_($.Duration).div(1000000),
      maxDurationMs: CH.max_($.Duration).div(1000000),
      p50DurationMs: CH.quantile(0.5)($.Duration).div(1000000),
      p95DurationMs: CH.quantile(0.95)($.Duration).div(1000000),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
      CH.when(opts.serviceName, (v: string) =>
        mm?.serviceName === "contains"
          ? CH.positionCaseInsensitive($.ServiceName, CH.lit(v)).gt(0)
          : $.ServiceName.eq(v),
      ),
      CH.when(opts.spanName, (v: string) =>
        mm?.spanName === "contains"
          ? CH.positionCaseInsensitive($.SpanName, CH.lit(v)).gt(0)
          : $.SpanName.eq(v),
      ),
      CH.whenTrue(!!opts.hasError, () => $.HasError.eq(1)),
      CH.when(opts.minDurationMs, (v: number) => $.Duration.gte(v * 1000000)),
      CH.when(opts.maxDurationMs, (v: number) => $.Duration.lte(v * 1000000)),
      CH.when(opts.httpMethod, (v: string) => $.HttpMethod.eq(v)),
      CH.when(opts.httpStatusCode, (v: string) => $.HttpStatusCode.eq(v)),
      CH.when(opts.deploymentEnv, (v: string) =>
        mm?.deploymentEnv === "contains"
          ? CH.positionCaseInsensitive($.DeploymentEnv, CH.lit(v)).gt(0)
          : $.DeploymentEnv.eq(v),
      ),
    ])
    .format("JSON")
}

// ---------------------------------------------------------------------------
// Traces facets (UNION ALL — 6 facet dimensions on trace_list_mv)
// ---------------------------------------------------------------------------

export interface TracesFacetsOpts {
  serviceName?: string
  spanName?: string
  hasError?: boolean
  minDurationMs?: number
  maxDurationMs?: number
  httpMethod?: string
  httpStatusCode?: string
  deploymentEnv?: string
  matchModes?: {
    serviceName?: "contains"
    spanName?: "contains"
    deploymentEnv?: "contains"
  }
  attributeFilterKey?: string
  attributeFilterValue?: string
  attributeFilterValueMatchMode?: "contains"
  resourceFilterKey?: string
  resourceFilterValue?: string
  resourceFilterValueMatchMode?: "contains"
}

export interface TracesFacetsOutput {
  readonly name: string
  readonly count: number
  readonly facetType: string
}

export function tracesFacetsQuery(
  opts: TracesFacetsOpts,
): CHUnionQuery<TracesFacetsOutput> {
  const baseWhere = ($: ColumnAccessor<typeof TraceListMv.columns>): Array<CH.Condition | undefined> => {
    const conditions: Array<CH.Condition | undefined> = [
      $.OrgId.eq(param.string("orgId")),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
    ]

    if (opts.serviceName) {
      conditions.push(
        opts.matchModes?.serviceName === "contains"
          ? CH.positionCaseInsensitive($.ServiceName, CH.lit(opts.serviceName)).gt(0)
          : $.ServiceName.eq(opts.serviceName),
      )
    }
    if (opts.spanName) {
      conditions.push(
        opts.matchModes?.spanName === "contains"
          ? CH.positionCaseInsensitive($.SpanName, CH.lit(opts.spanName)).gt(0)
          : $.SpanName.eq(opts.spanName),
      )
    }
    if (opts.hasError) conditions.push($.HasError.eq(1))
    if (opts.minDurationMs != null) conditions.push($.Duration.gte(opts.minDurationMs * 1000000))
    if (opts.maxDurationMs != null) conditions.push($.Duration.lte(opts.maxDurationMs * 1000000))
    if (opts.httpMethod) conditions.push($.HttpMethod.eq(opts.httpMethod))
    if (opts.httpStatusCode) conditions.push($.HttpStatusCode.eq(opts.httpStatusCode))
    if (opts.deploymentEnv) {
      conditions.push(
        opts.matchModes?.deploymentEnv === "contains"
          ? CH.positionCaseInsensitive($.DeploymentEnv, CH.lit(opts.deploymentEnv)).gt(0)
          : $.DeploymentEnv.eq(opts.deploymentEnv),
      )
    }

    // Attribute filter EXISTS subqueries (correlated — references outer TraceId)
    if (opts.attributeFilterKey) {
      const attrCol = CH.mapGet(CH.dynamicColumn<Record<string, string>>("t_attr.SpanAttributes"), opts.attributeFilterKey)
      const matchCond = opts.attributeFilterValueMatchMode === "contains"
        ? CH.positionCaseInsensitive(attrCol, CH.lit(opts.attributeFilterValue ?? "")).gt(0)
        : attrCol.eq(opts.attributeFilterValue ?? "")
      const innerSql = compileCH(
        from(Traces, "t_attr")
          .select(() => ({ _: CH.lit(1) }))
          .where(() => [
            CH.dynamicColumn("t_attr.TraceId").eq(CH.outerRef("TraceId")),
            CH.dynamicColumn("t_attr.OrgId").eq(param.string("orgId")),
            CH.dynamicColumn<string>("t_attr.Timestamp").gte(param.dateTime("startTime")),
            CH.dynamicColumn<string>("t_attr.Timestamp").lte(param.dateTime("endTime")),
            matchCond,
          ]),
        {},
        { skipFormat: true },
      )
      conditions.push(CH.exists(innerSql.sql))
    }
    if (opts.resourceFilterKey) {
      const resCol = CH.mapGet(CH.dynamicColumn<Record<string, string>>("t_res.ResourceAttributes"), opts.resourceFilterKey)
      const matchCond = opts.resourceFilterValueMatchMode === "contains"
        ? CH.positionCaseInsensitive(resCol, CH.lit(opts.resourceFilterValue ?? "")).gt(0)
        : resCol.eq(opts.resourceFilterValue ?? "")
      const innerSql = compileCH(
        from(Traces, "t_res")
          .select(() => ({ _: CH.lit(1) }))
          .where(() => [
            CH.dynamicColumn("t_res.TraceId").eq(CH.outerRef("TraceId")),
            CH.dynamicColumn("t_res.OrgId").eq(param.string("orgId")),
            CH.dynamicColumn<string>("t_res.Timestamp").gte(param.dateTime("startTime")),
            CH.dynamicColumn<string>("t_res.Timestamp").lte(param.dateTime("endTime")),
            matchCond,
          ]),
        {},
        { skipFormat: true },
      )
      conditions.push(CH.exists(innerSql.sql))
    }

    return conditions
  }

  const makeFacetQuery = (
    colName: string,
    facetType: string,
    extraWhere?: ($: ColumnAccessor<typeof TraceListMv.columns>) => CH.Condition,
    limit = 50,
  ) =>
    from(TraceListMv)
      .select((_$) => ({
        name: CH.dynamicColumn<string>(colName),
        count: CH.count(),
        facetType: CH.lit(facetType),
      }))
      .where(($) => [
        ...baseWhere($),
        extraWhere?.($),
      ])
      .groupBy("name")
      .orderBy(["count", "desc"])
      .limit(limit)

  return unionAll(
    makeFacetQuery("ServiceName", "service"),
    makeFacetQuery("SpanName", "spanName", ($) => $.SpanName.neq(""), 20),
    makeFacetQuery("HttpMethod", "httpMethod", ($) => $.HttpMethod.neq(""), 20),
    makeFacetQuery("HttpStatusCode", "httpStatus", ($) => $.HttpStatusCode.neq(""), 20),
    makeFacetQuery("DeploymentEnv", "deploymentEnv", ($) => $.DeploymentEnv.neq(""), 20),
    from(TraceListMv)
      .select(() => ({
        name: CH.lit("error"),
        count: CH.count(),
        facetType: CH.lit("errorCount"),
      }))
      .where(($) => [...baseWhere($), $.HasError.eq(1)]),
  ).format("JSON")
}

// ---------------------------------------------------------------------------
// Errors facets (UNION ALL — service + environment + error_type facets)
// ---------------------------------------------------------------------------

export interface ErrorsFacetsOpts {
  rootOnly?: boolean
  services?: readonly string[]
  deploymentEnvs?: readonly string[]
  errorTypes?: readonly string[]
}

export interface ErrorsFacetsOutput {
  readonly name: string
  readonly count: number
  readonly facetType: string
}

export function errorsFacetsQuery(
  opts: ErrorsFacetsOpts,
): CHUnionQuery<ErrorsFacetsOutput> {
  const baseWhere = ($: ColumnAccessor<typeof ErrorSpans.columns>): Array<CH.Condition | undefined> => [
    $.OrgId.eq(param.string("orgId")),
    $.Timestamp.gte(param.dateTime("startTime")),
    $.Timestamp.lte(param.dateTime("endTime")),
    CH.whenTrue(!!opts.rootOnly, () => $.ParentSpanId.eq("")),
    opts.services?.length
      ? CH.inList($.ServiceName, opts.services)
      : undefined,
    opts.deploymentEnvs?.length
      ? CH.inList($.DeploymentEnv, opts.deploymentEnvs)
      : undefined,
    opts.errorTypes?.length
      ? CH.inList(errorFingerprint($.StatusMessage), opts.errorTypes)
      : undefined,
  ]

  const serviceQuery = from(ErrorSpans)
    .select(($) => ({
      name: $.ServiceName,
      count: CH.count(),
      facetType: CH.lit("service"),
    }))
    .where(baseWhere)
    .groupBy("name")
    .orderBy(["count", "desc"])
    .limit(100)

  const envQuery = from(ErrorSpans)
    .select(($) => ({
      name: $.DeploymentEnv,
      count: CH.count(),
      facetType: CH.lit("environment"),
    }))
    .where(($) => [...baseWhere($), $.DeploymentEnv.neq("")])
    .groupBy("name")
    .orderBy(["count", "desc"])
    .limit(100)

  const errorTypeQuery = from(ErrorSpans)
    .select(($) => ({
      name: errorFingerprint($.StatusMessage),
      count: CH.count(),
      facetType: CH.lit("error_type"),
    }))
    .where(baseWhere)
    .groupBy("name")
    .orderBy(["count", "desc"])
    .limit(50)

  return unionAll(serviceQuery, envQuery, errorTypeQuery)
    .format("JSON")
}

// ---------------------------------------------------------------------------
// Errors summary (CROSS JOIN between error_spans and service_usage)
// ---------------------------------------------------------------------------

export interface ErrorsSummaryOpts {
  rootOnly?: boolean
  services?: readonly string[]
  deploymentEnvs?: readonly string[]
  errorTypes?: readonly string[]
}

export interface ErrorsSummaryOutput {
  readonly totalErrors: number
  readonly totalSpans: number
  readonly errorRate: number
  readonly affectedServicesCount: number
  readonly affectedTracesCount: number
}

export function errorsSummaryQuery(
  opts: ErrorsSummaryOpts,
) {
  const errorSub = from(ErrorSpans)
    .select(($) => ({
      totalErrors: CH.count(),
      affectedServicesCount: CH.uniq($.ServiceName),
      affectedTracesCount: CH.uniq($.TraceId),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
      CH.whenTrue(!!opts.rootOnly, () => $.ParentSpanId.eq("")),
      opts.services?.length ? CH.inList($.ServiceName, opts.services) : undefined,
      opts.deploymentEnvs?.length ? CH.inList($.DeploymentEnv, opts.deploymentEnvs) : undefined,
      opts.errorTypes?.length ? CH.inList(errorFingerprint($.StatusMessage), opts.errorTypes) : undefined,
    ])

  const usageSub = from(ServiceUsage)
    .select(($) => ({
      totalSpans: CH.sum($.TraceCount),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.Hour.gte(param.dateTime("startTime")),
      $.Hour.lte(param.dateTime("endTime")),
    ])

  return fromQuery(errorSub, "e")
    .crossJoinQuery(usageSub, "s")
    .select(($) => ({
      totalErrors: $.totalErrors,
      totalSpans: $.s.totalSpans,
      errorRate: CH.if_(
        $.s.totalSpans.gt(0),
        CH.round_($.totalErrors.div($.s.totalSpans).mul(100), 4),
        CH.lit(0),
      ),
      affectedServicesCount: $.affectedServicesCount,
      affectedTracesCount: $.affectedTracesCount,
    }))
    .format("JSON")
}

// ---------------------------------------------------------------------------
// Error detail traces (INNER JOIN with error subquery)
// ---------------------------------------------------------------------------

export interface ErrorDetailTracesOpts {
  errorType: string
  rootOnly?: boolean
  services?: readonly string[]
  limit?: number
}

export interface ErrorDetailTracesOutput {
  readonly traceId: string
  readonly startTime: string
  readonly durationMicros: number
  readonly spanCount: number
  readonly services: readonly string[]
  readonly rootSpanName: string
  readonly errorMessage: string
}

export function errorDetailTracesQuery(
  opts: ErrorDetailTracesOpts,
) {
  const limit = opts.limit ?? 10

  // Subquery: find distinct matching error TraceIds
  const errorSub = from(ErrorSpans)
    .select(($) => ({ TraceId: $.TraceId }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      errorFingerprint($.StatusMessage).eq(opts.errorType),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
      CH.whenTrue(!!opts.rootOnly, () => $.ParentSpanId.eq("")),
      opts.services?.length ? CH.inList($.ServiceName, opts.services) : undefined,
    ])
    .groupBy("TraceId")
    .orderBy(["TraceId", "desc"])
    .limit(limit)

  // Outer query: join traces with error subquery
  return from(Traces)
    .innerJoinQuery(errorSub, "e", (main, e) => main.TraceId.eq(e.TraceId))
    .select(($) => ({
      traceId: $.TraceId,
      startTime: CH.min_($.Timestamp),
      durationMicros: CH.intDiv(CH.max_($.Duration), 1000),
      spanCount: CH.count(),
      services: CH.groupUniqArray($.ServiceName),
      rootSpanName: CH.anyIf($.SpanName, $.ParentSpanId.eq("")),
      errorMessage: CH.any_($.StatusMessage),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
    ])
    .groupBy("traceId")
    .orderBy(["startTime", "desc"])
    .format("JSON")
}
