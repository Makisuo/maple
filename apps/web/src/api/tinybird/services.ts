import { Effect, Schema } from "effect"
import { getTinybird, type ServiceOverviewOutput, type ServicesFacetsOutput } from "@/lib/tinybird";
import {
  buildBucketTimeline,
  computeBucketSeconds,
  toIsoBucket,
} from "@/api/tinybird/timeseries-utils";
import { estimateThroughput } from "@/lib/sampling";
import {
  TinybirdDateTimeString,
  decodeInput,
  runTinybirdQuery,
} from "@/api/tinybird/effect-utils"

// Date format: "YYYY-MM-DD HH:mm:ss" (Tinybird/ClickHouse compatible)
const dateTimeString = TinybirdDateTimeString

// Service overview types
export interface CommitBreakdown {
  commitSha: string;
  spanCount: number;
  percentage: number;
}

export interface ServiceOverview {
  serviceName: string;
  environment: string;
  commits: CommitBreakdown[];
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  errorRate: number;
  throughput: number;
  tracedThroughput: number;
  hasSampling: boolean;
  samplingWeight: number;
}

export interface ServiceOverviewResponse {
  data: ServiceOverview[];
}

const GetServiceOverviewInput = Schema.Struct({
  startTime: Schema.optional(dateTimeString),
  endTime: Schema.optional(dateTimeString),
  environments: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  commitShas: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
})

export type GetServiceOverviewInput = Schema.Schema.Type<typeof GetServiceOverviewInput>

interface CoercedRow {
  serviceName: string;
  environment: string;
  commitSha: string;
  spanCount: number;
  errorCount: number;
  totalCount: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  sampledSpanCount: number;
  unsampledSpanCount: number;
  dominantThreshold: string;
}

function coerceRow(raw: ServiceOverviewOutput): CoercedRow {
  return {
    serviceName: raw.serviceName,
    environment: raw.environment || "unknown",
    commitSha: raw.commitSha || "N/A",
    spanCount: Number(raw.spanCount),
    errorCount: Number(raw.errorCount),
    totalCount: Number(raw.throughput),
    p50LatencyMs: Number(raw.p50LatencyMs),
    p95LatencyMs: Number(raw.p95LatencyMs),
    p99LatencyMs: Number(raw.p99LatencyMs),
    sampledSpanCount: Number(raw.sampledSpanCount),
    unsampledSpanCount: Number(raw.unsampledSpanCount),
    dominantThreshold: raw.dominantThreshold || "",
  };
}

function aggregateByServiceEnvironment(
  rows: CoercedRow[],
  durationSeconds: number,
): ServiceOverview[] {
  const groups = new Map<string, CoercedRow[]>();

  for (const row of rows) {
    const key = `${row.serviceName}::${row.environment}`;
    const group = groups.get(key);
    if (group) {
      group.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  const results: ServiceOverview[] = [];

  for (const group of groups.values()) {
    const totalSpans = group.reduce((sum, r) => sum + r.spanCount, 0);
    const totalErrors = group.reduce((sum, r) => sum + r.errorCount, 0);
    const totalSampled = group.reduce((sum, r) => sum + r.sampledSpanCount, 0);
    const totalUnsampled = group.reduce((sum, r) => sum + r.unsampledSpanCount, 0);

    // Use the first non-empty threshold found across commit groups
    let threshold = "";
    for (const r of group) {
      if (r.dominantThreshold) {
        threshold = r.dominantThreshold;
        break;
      }
    }

    const sampling = estimateThroughput(totalSampled, totalUnsampled, threshold, durationSeconds);

    // Weighted average of latencies by span count
    let p50 = 0;
    let p95 = 0;
    let p99 = 0;
    if (totalSpans > 0) {
      for (const r of group) {
        const weight = r.spanCount / totalSpans;
        p50 += r.p50LatencyMs * weight;
        p95 += r.p95LatencyMs * weight;
        p99 += r.p99LatencyMs * weight;
      }
    }

    const commits: CommitBreakdown[] = group
      .map((r) => ({
        commitSha: r.commitSha,
        spanCount: r.spanCount,
        percentage:
          totalSpans > 0
            ? Math.round((r.spanCount / totalSpans) * 100)
            : 0,
      }))
      .sort((a, b) => b.percentage - a.percentage);

    results.push({
      serviceName: group[0].serviceName,
      environment: group[0].environment,
      commits,
      p50LatencyMs: p50,
      p95LatencyMs: p95,
      p99LatencyMs: p99,
      errorRate: totalSpans > 0 ? (totalErrors / totalSpans) * 100 : 0,
      throughput: sampling.hasSampling ? sampling.estimated : sampling.traced,
      tracedThroughput: sampling.traced,
      hasSampling: sampling.hasSampling,
      samplingWeight: sampling.weight,
    });
  }

  // Sort by throughput descending (same as SQL ORDER BY)
  results.sort((a, b) => b.throughput - a.throughput);
  return results;
}

export function getServiceOverview({
  data,
}: {
  data: GetServiceOverviewInput
}) {
  return getServiceOverviewEffect({ data })
}

const getServiceOverviewEffect = Effect.fn("Tinybird.getServiceOverview")(function* ({
  data,
}: {
  data: GetServiceOverviewInput
}) {
    const input = yield* decodeInput(GetServiceOverviewInput, data ?? {}, "getServiceOverview")

    const tinybird = getTinybird()
    const result = yield* runTinybirdQuery("service_overview", () =>
      tinybird.query.service_overview({
        start_time: input.startTime,
        end_time: input.endTime,
        environments: input.environments?.join(","),
        commit_shas: input.commitShas?.join(","),
      }),
    )

    const startMs = input.startTime
      ? new Date(input.startTime.replace(" ", "T") + "Z").getTime()
      : 0
    const endMs = input.endTime
      ? new Date(input.endTime.replace(" ", "T") + "Z").getTime()
      : 0
    const durationSeconds =
      startMs > 0 && endMs > 0
        ? Math.max((endMs - startMs) / 1000, 1)
        : 3600

    const coercedRows = result.data.map(coerceRow)
    return {
      data: aggregateByServiceEnvironment(coercedRows, durationSeconds),
    }
})

// Service overview time series types
export interface ServiceTimeSeriesPoint {
  bucket: string;
  throughput: number;
  errorRate: number;
}

export interface ServiceOverviewTimeSeriesResponse {
  data: Record<string, ServiceTimeSeriesPoint[]>;
}

function sortByBucket<T extends { bucket: string }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => left.bucket.localeCompare(right.bucket));
}

function fillServiceApdexPoints(
  points: ServiceApdexTimeSeriesPoint[],
  startTime: string | undefined,
  endTime: string | undefined,
  bucketSeconds: number,
): ServiceApdexTimeSeriesPoint[] {
  const timeline = buildBucketTimeline(startTime, endTime, bucketSeconds);
  if (timeline.length === 0) {
    return sortByBucket(points);
  }

  const byBucket = new Map<string, ServiceApdexTimeSeriesPoint>();
  for (const point of points) {
    byBucket.set(toIsoBucket(point.bucket), point);
  }

  return timeline.map((bucket) => {
    const existing = byBucket.get(bucket);
    if (existing) {
      return existing;
    }

    return {
      bucket,
      apdexScore: 0,
      totalCount: 0,
    };
  });
}

// Service facets types
export interface FacetItem {
  name: string;
  count: number;
}

export interface ServicesFacets {
  environments: FacetItem[];
  commitShas: FacetItem[];
}

export interface ServicesFacetsResponse {
  data: ServicesFacets;
}

const GetServicesFacetsInput = Schema.Struct({
  startTime: Schema.optional(dateTimeString),
  endTime: Schema.optional(dateTimeString),
})

export type GetServicesFacetsInput = Schema.Schema.Type<typeof GetServicesFacetsInput>

function transformServicesFacets(facetsData: ServicesFacetsOutput[]): ServicesFacets {
  const environments: FacetItem[] = [];
  const commitShas: FacetItem[] = [];

  for (const row of facetsData) {
    const item = { name: row.name, count: Number(row.count) };
    switch (row.facetType) {
      case "environment":
        environments.push(item);
        break;
      case "commitSha":
        commitShas.push(item);
        break;
    }
  }

  return { environments, commitShas };
}

export function getServicesFacets({
  data,
}: {
  data: GetServicesFacetsInput
}) {
  return getServicesFacetsEffect({ data })
}

const getServicesFacetsEffect = Effect.fn("Tinybird.getServicesFacets")(function* ({
  data,
}: {
  data: GetServicesFacetsInput
}) {
    const input = yield* decodeInput(GetServicesFacetsInput, data ?? {}, "getServicesFacets")
    const tinybird = getTinybird()
    const result = yield* runTinybirdQuery("services_facets", () =>
      tinybird.query.services_facets({
        start_time: input.startTime,
        end_time: input.endTime,
      }),
    )

    return {
      data: transformServicesFacets(result.data),
    }
})

// Service detail types
export interface ServiceDetailTimeSeriesPoint {
  bucket: string;
  throughput: number;
  errorRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
}

export interface ServiceDetailTimeSeriesResponse {
  data: ServiceDetailTimeSeriesPoint[];
}

export interface ServiceApdexTimeSeriesPoint {
  bucket: string;
  apdexScore: number;
  totalCount: number;
}

export interface ServiceApdexTimeSeriesResponse {
  data: ServiceApdexTimeSeriesPoint[];
}

const GetServiceDetailInput = Schema.Struct({
  serviceName: Schema.String,
  startTime: Schema.optional(dateTimeString),
  endTime: Schema.optional(dateTimeString),
})

export type GetServiceDetailInput = Schema.Schema.Type<typeof GetServiceDetailInput>

export function getServiceApdexTimeSeries({
  data,
}: {
  data: GetServiceDetailInput
}) {
  return getServiceApdexTimeSeriesEffect({ data })
}

const getServiceApdexTimeSeriesEffect = Effect.fn("Tinybird.getServiceApdexTimeSeries")(
  function* ({
    data,
  }: {
    data: GetServiceDetailInput
  }) {
    const input = yield* decodeInput(GetServiceDetailInput, data, "getServiceApdexTimeSeries")
    const tinybird = getTinybird()
    const bucketSeconds = computeBucketSeconds(input.startTime, input.endTime)
    const result = yield* runTinybirdQuery("service_apdex_time_series", () =>
      tinybird.query.service_apdex_time_series({
        service_name: input.serviceName,
        start_time: input.startTime,
        end_time: input.endTime,
        bucket_seconds: bucketSeconds,
      }),
    )

    const points = result.data.map((row) => ({
      bucket: toIsoBucket(row.bucket),
      apdexScore: Number(row.apdexScore),
      totalCount: Number(row.totalCount),
    }))

    return {
      data: fillServiceApdexPoints(
        points,
        input.startTime,
        input.endTime,
        bucketSeconds,
      ),
    }
  },
)
