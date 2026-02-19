import { z } from "zod";
import { getTinybird, type ListTracesOutput, type SpanHierarchyOutput, type TracesFacetsOutput, type TracesDurationStatsOutput } from "@/lib/tinybird";

// Input validation schemas
// Date format: "YYYY-MM-DD HH:mm:ss" (Tinybird/ClickHouse compatible)
const dateTimeString = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "Invalid datetime format")

const ListTracesInput = z.object({
  limit: z.number().min(1).max(1000).optional(),
  offset: z.number().min(0).optional(),
  service: z.string().optional(),
  startTime: dateTimeString.optional(),
  endTime: dateTimeString.optional(),
  spanName: z.string().optional(),
  hasError: z.boolean().optional(),
  minDurationMs: z.number().optional(),
  maxDurationMs: z.number().optional(),
  httpMethod: z.string().optional(),
  httpStatusCode: z.string().optional(),
  deploymentEnv: z.string().optional(),
  rootOnly: z.boolean().optional(),
});

export type ListTracesInput = z.infer<typeof ListTracesInput>;

// Default values applied at runtime
const DEFAULT_LIMIT = 100;
const DEFAULT_OFFSET = 0;

// Transformed trace for client use
export interface Trace {
  traceId: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  spanCount: number;
  services: string[];
  rootSpanName: string;
  hasError: boolean;
}

export interface TracesResponse {
  data: Trace[];
  meta: {
    limit: number;
    offset: number;
  };
  error: string | null;
}

function transformTrace(raw: ListTracesOutput): Trace {
  return {
    traceId: raw.traceId,
    startTime: String(raw.startTime),
    endTime: String(raw.endTime),
    durationMs: Number(raw.durationMicros) / 1000,
    spanCount: Number(raw.spanCount),
    services: raw.services,
    rootSpanName: raw.rootSpanName,
    hasError: Number(raw.hasError) === 1,
  };
}

export async function listTraces({
  data,
}: {
  data: ListTracesInput
}): Promise<TracesResponse> {
  data = ListTracesInput.parse(data ?? {})
  const limit = data.limit ?? DEFAULT_LIMIT;
  const offset = data.offset ?? DEFAULT_OFFSET;

  try {
    const tinybird = getTinybird();
    const result = await tinybird.query.list_traces({
      limit,
      offset,
      service: data.service,
      start_time: data.startTime,
      end_time: data.endTime,
      span_name: data.spanName,
      has_error: data.hasError,
      min_duration_ms: data.minDurationMs,
      max_duration_ms: data.maxDurationMs,
      http_method: data.httpMethod,
      http_status_code: data.httpStatusCode,
      deployment_env: data.deploymentEnv,
      root_only: data.rootOnly,
    });

    return {
      data: result.data.map(transformTrace),
      meta: {
        limit,
        offset,
      },
      error: null,
    };
  } catch (error) {
    console.error("[Tinybird] listTraces failed:", error);
    return {
      data: [],
      meta: {
        limit,
        offset,
      },
      error:
        error instanceof Error ? error.message : "Failed to fetch traces",
    };
  }
}

// Transformed span for client use
export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  spanName: string;
  serviceName: string;
  spanKind: string;
  durationMs: number;
  startTime: string;
  statusCode: string;
  statusMessage: string;
  spanAttributes: Record<string, string>;
  resourceAttributes: Record<string, string>;
}

// Span with children for tree structure
export interface SpanNode extends Span {
  children: SpanNode[];
  depth: number;
}

export interface SpanHierarchyResponse {
  traceId: string;
  spans: Span[];
  rootSpans: SpanNode[];
  totalDurationMs: number;
  error: string | null;
}

const GetSpanHierarchyInput = z.object({
  traceId: z.string().min(1, "traceId is required"),
  spanId: z.string().optional(),
});

export type GetSpanHierarchyInput = z.infer<typeof GetSpanHierarchyInput>;

function transformSpan(raw: SpanHierarchyOutput): Span {
  return {
    traceId: raw.traceId,
    spanId: raw.spanId,
    parentSpanId: raw.parentSpanId,
    spanName: raw.spanName,
    serviceName: raw.serviceName,
    spanKind: raw.spanKind,
    durationMs: Number(raw.durationMs),
    startTime: String(raw.startTime),
    statusCode: raw.statusCode,
    statusMessage: raw.statusMessage,
    spanAttributes: raw.spanAttributes ? JSON.parse(raw.spanAttributes) : {},
    resourceAttributes: raw.resourceAttributes ? JSON.parse(raw.resourceAttributes) : {},
  };
}

function buildSpanTree(spans: Span[]): SpanNode[] {
  const spanMap = new Map<string, SpanNode>();
  const rootSpans: SpanNode[] = [];

  // Create nodes for all spans
  for (const span of spans) {
    spanMap.set(span.spanId, { ...span, children: [], depth: 0 });
  }

  // Build tree structure
  for (const span of spans) {
    const node = spanMap.get(span.spanId)!;
    if (span.parentSpanId && spanMap.has(span.parentSpanId)) {
      const parent = spanMap.get(span.parentSpanId)!;
      parent.children.push(node);
    } else {
      rootSpans.push(node);
    }
  }

  // Set depths
  function setDepth(node: SpanNode, depth: number) {
    node.depth = depth;
    for (const child of node.children) {
      setDepth(child, depth + 1);
    }
  }

  for (const root of rootSpans) {
    setDepth(root, 0);
  }

  // Sort children by start time
  function sortChildren(node: SpanNode) {
    node.children.sort(
      (a, b) =>
        new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
    );
    for (const child of node.children) {
      sortChildren(child);
    }
  }

  for (const root of rootSpans) {
    sortChildren(root);
  }

  // Sort root spans by start time
  rootSpans.sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
  );

  return rootSpans;
}

// Server function to fetch span hierarchy
export async function getSpanHierarchy({
  data,
}: {
  data: GetSpanHierarchyInput
}): Promise<SpanHierarchyResponse> {
  data = GetSpanHierarchyInput.parse(data)

  try {
    const tinybird = getTinybird();

    const result = await tinybird.query.span_hierarchy({
      trace_id: data.traceId,
      span_id: data.spanId,
    });

    const spans = result.data.map(transformSpan);
    const rootSpans = buildSpanTree(spans);

    const totalDurationMs =
      spans.length > 0 ? Math.max(...spans.map((s) => s.durationMs)) : 0;

    return {
      traceId: data.traceId,
      spans,
      rootSpans,
      totalDurationMs,
      error: null,
    };
  } catch (error) {
    console.error("[Tinybird] getSpanHierarchy failed:", error);
    return {
      traceId: data.traceId,
      spans: [],
      rootSpans: [],
      totalDurationMs: 0,
      error:
        error instanceof Error
          ? error.message
          : "Failed to fetch span hierarchy",
    };
  }
}

// Facets types
export interface FacetItem {
  name: string;
  count: number;
}

export interface TracesFacets {
  services: FacetItem[];
  spanNames: FacetItem[];
  httpMethods: FacetItem[];
  httpStatusCodes: FacetItem[];
  deploymentEnvs: FacetItem[];
  errorCount: number;
  durationStats: {
    minDurationMs: number;
    maxDurationMs: number;
    p50DurationMs: number;
    p95DurationMs: number;
  };
}

export interface TracesFacetsResponse {
  data: TracesFacets;
  error: string | null;
}

export interface TracesDurationStatsResponse {
  data: Array<{
    minDurationMs: number;
    maxDurationMs: number;
    p50DurationMs: number;
    p95DurationMs: number;
  }>;
  error: string | null;
}

const GetTracesFacetsInput = z.object({
  startTime: dateTimeString.optional(),
  endTime: dateTimeString.optional(),
  service: z.string().optional(),
  spanName: z.string().optional(),
  hasError: z.boolean().optional(),
  minDurationMs: z.number().optional(),
  maxDurationMs: z.number().optional(),
  httpMethod: z.string().optional(),
  httpStatusCode: z.string().optional(),
  deploymentEnv: z.string().optional(),
});

export type GetTracesFacetsInput = z.infer<typeof GetTracesFacetsInput>;

function transformFacets(
  facetsData: TracesFacetsOutput[],
  durationStatsData: TracesDurationStatsOutput[]
): TracesFacets {
  const services: FacetItem[] = [];
  const spanNames: FacetItem[] = [];
  const httpMethods: FacetItem[] = [];
  const httpStatusCodes: FacetItem[] = [];
  const deploymentEnvs: FacetItem[] = [];
  let errorCount = 0;

  for (const row of facetsData) {
    const item = { name: row.name, count: Number(row.count) };
    switch (row.facetType) {
      case "service":
        services.push(item);
        break;
      case "spanName":
        spanNames.push(item);
        break;
      case "httpMethod":
        httpMethods.push(item);
        break;
      case "httpStatus":
        httpStatusCodes.push(item);
        break;
      case "deploymentEnv":
        deploymentEnvs.push(item);
        break;
      case "errorCount":
        errorCount = Number(row.count);
        break;
    }
  }

  const durationStats = durationStatsData[0]
    ? {
        minDurationMs: Number(durationStatsData[0].minDurationMs),
        maxDurationMs: Number(durationStatsData[0].maxDurationMs),
        p50DurationMs: Number(durationStatsData[0].p50DurationMs),
        p95DurationMs: Number(durationStatsData[0].p95DurationMs),
      }
    : { minDurationMs: 0, maxDurationMs: 0, p50DurationMs: 0, p95DurationMs: 0 };

  return {
    services,
    spanNames,
    httpMethods,
    httpStatusCodes,
    deploymentEnvs,
    errorCount,
    durationStats,
  };
}

export async function getTracesFacets({
  data,
}: {
  data: GetTracesFacetsInput
}): Promise<TracesFacetsResponse> {
  data = GetTracesFacetsInput.parse(data ?? {})

  try {
    const tinybird = getTinybird();

    const [facetsResult, durationStatsResult] = await Promise.all([
      tinybird.query.traces_facets({
        start_time: data.startTime,
        end_time: data.endTime,
        service: data.service,
        span_name: data.spanName,
        has_error: data.hasError,
        min_duration_ms: data.minDurationMs,
        max_duration_ms: data.maxDurationMs,
        http_method: data.httpMethod,
        http_status_code: data.httpStatusCode,
        deployment_env: data.deploymentEnv,
      }),
      tinybird.query.traces_duration_stats({
        start_time: data.startTime,
        end_time: data.endTime,
        service: data.service,
        span_name: data.spanName,
        has_error: data.hasError,
        http_method: data.httpMethod,
        http_status_code: data.httpStatusCode,
        deployment_env: data.deploymentEnv,
      }),
    ]);

    return {
      data: transformFacets(facetsResult.data, durationStatsResult.data),
      error: null,
    };
  } catch (error) {
    console.error("[Tinybird] getTracesFacets failed:", error);
    return {
      data: {
        services: [],
        spanNames: [],
        httpMethods: [],
        httpStatusCodes: [],
        deploymentEnvs: [],
        errorCount: 0,
        durationStats: { minDurationMs: 0, maxDurationMs: 0, p50DurationMs: 0, p95DurationMs: 0 },
      },
      error:
        error instanceof Error ? error.message : "Failed to fetch traces facets",
    };
  }
}

export async function getTracesDurationStats({
  data,
}: {
  data: GetTracesFacetsInput
}): Promise<TracesDurationStatsResponse> {
  data = GetTracesFacetsInput.parse(data ?? {})

  try {
    const tinybird = getTinybird();
    const result = await tinybird.query.traces_duration_stats({
      start_time: data.startTime,
      end_time: data.endTime,
      service: data.service,
      span_name: data.spanName,
      has_error: data.hasError,
      http_method: data.httpMethod,
      http_status_code: data.httpStatusCode,
      deployment_env: data.deploymentEnv,
    });

    return {
      data: result.data.map((row) => ({
        minDurationMs: Number(row.minDurationMs),
        maxDurationMs: Number(row.maxDurationMs),
        p50DurationMs: Number(row.p50DurationMs),
        p95DurationMs: Number(row.p95DurationMs),
      })),
      error: null,
    };
  } catch (error) {
    console.error("[Tinybird] getTracesDurationStats failed:", error);
    return {
      data: [
        {
          minDurationMs: 0,
          maxDurationMs: 0,
          p50DurationMs: 0,
          p95DurationMs: 0,
        },
      ],
      error: error instanceof Error ? error.message : "Failed to fetch trace duration stats",
    };
  }
}

// --- Span Attribute Keys ---

const GetSpanAttributeKeysInput = z.object({
  startTime: dateTimeString.optional(),
  endTime: dateTimeString.optional(),
});

export type GetSpanAttributeKeysInput = z.infer<typeof GetSpanAttributeKeysInput>;

export interface SpanAttributeKeysResponse {
  data: Array<{ attributeKey: string; usageCount: number }>;
  error: string | null;
}

export async function getSpanAttributeKeys({
  data,
}: {
  data: GetSpanAttributeKeysInput;
}): Promise<SpanAttributeKeysResponse> {
  data = GetSpanAttributeKeysInput.parse(data ?? {});

  try {
    const tinybird = getTinybird();
    const result = await tinybird.query.span_attribute_keys({
      start_time: data.startTime,
      end_time: data.endTime,
    });

    return {
      data: result.data.map((row) => ({
        attributeKey: row.attributeKey,
        usageCount: Number(row.usageCount),
      })),
      error: null,
    };
  } catch (error) {
    console.error("[Tinybird] getSpanAttributeKeys failed:", error);
    return {
      data: [],
      error: error instanceof Error ? error.message : "Failed to fetch span attribute keys",
    };
  }
}

// --- Span Attribute Values ---

const GetSpanAttributeValuesInput = z.object({
  startTime: dateTimeString.optional(),
  endTime: dateTimeString.optional(),
  attributeKey: z.string(),
});

export type GetSpanAttributeValuesInput = z.infer<typeof GetSpanAttributeValuesInput>;

export interface SpanAttributeValuesResponse {
  data: Array<{ attributeValue: string; usageCount: number }>;
  error: string | null;
}

export async function getSpanAttributeValues({
  data,
}: {
  data: GetSpanAttributeValuesInput;
}): Promise<SpanAttributeValuesResponse> {
  data = GetSpanAttributeValuesInput.parse(data ?? {});

  if (!data.attributeKey) {
    return { data: [], error: null };
  }

  try {
    const tinybird = getTinybird();
    const result = await tinybird.query.span_attribute_values({
      start_time: data.startTime,
      end_time: data.endTime,
      attribute_key: data.attributeKey,
    });

    return {
      data: result.data.map((row) => ({
        attributeValue: row.attributeValue,
        usageCount: Number(row.usageCount),
      })),
      error: null,
    };
  } catch (error) {
    console.error("[Tinybird] getSpanAttributeValues failed:", error);
    return {
      data: [],
      error: error instanceof Error ? error.message : "Failed to fetch span attribute values",
    };
  }
}
