import * as CH from "@maple/query-engine/ch";
import * as Integrations from "@maple/query-engine-integrations";
import { defineQuery } from "@maple/query-engine/registry";
import { Queries as Core } from "@maple/query-engine/registry";
import type {
  CloudflareInfraZoneBreakdownRequest,
  HostInfraTimeseriesRequest,
  CloudflareInfraZoneFacetsRequest,
  CloudflareInfraZoneDetailRequest,
  ServicePlanetScaleStatsRequest,
  CloudflareInfraPlatformResourcesRequest,
  CloudflareInfraWorkersRequest,
  CloudflareInfraZoneDnsRequest,
  CloudflareInfraZoneSecurityRequest,
  CloudflareInfraZoneTimeseriesRequest,
  CloudflareInfraZonesRequest,
  FleetUtilizationTimeseriesRequest,
  GetLogRequest,
  NodeInfraTimeseriesRequest,
  PlanetScaleInfraTimeseriesRequest,
  PodInfraTimeseriesRequest,
  ServiceCloudflareStatsRequest,
  SpanDetailRequest,
  WorkloadInfraTimeseriesRequest,
} from "@maple/domain/http";
import {
  hostMetricSpec,
  nodeMetricSpec,
  partitionWindowAround,
  podMetricSpec,
  toCloudflareFilters,
  workloadMetricSpec,
} from "@/routes/query-helpers";
import { traceCacheTtlSeconds } from "@/services/warehouse/trace-detail-cache";

// App-side queries depend on integrations or API-only helpers, so moving them
// into the core registry would invert dependencies. Entries own query inputs;
// handlers retain only response metadata such as `ignoredFilters`.

const cloudflareInfraZoneCounters = defineQuery({
  id: "cloudflareInfraZoneCounters",
  profile: "aggregation",
  cache: 15,
  compile: (payload: CloudflareInfraZonesRequest, orgId: string) => {
    const params = {
      orgId: orgId,
      startTime: payload.startTime,
      endTime: payload.endTime,
    };
    // Counters (metrics_sum) + percentiles (metrics_gauge) run
    // concurrently, then merge by ServiceName — same shape as
    // serviceCloudflareStats above.
    const filters = toCloudflareFilters(payload);
    return CH.compile(Integrations.cloudflareZoneCountersSQL(filters), params, {
      rowSchema: Integrations.cloudflareZoneCountersRowSchema,
    });
  },
});

const cloudflareInfraZoneLatency = defineQuery({
  id: "cloudflareInfraZoneLatency",
  profile: "aggregation",
  cache: 15,
  compile: (payload: CloudflareInfraZonesRequest, orgId: string) => {
    const params = {
      orgId: orgId,
      startTime: payload.startTime,
      endTime: payload.endTime,
    };
    // Counters (metrics_sum) + percentiles (metrics_gauge) run
    // concurrently, then merge by ServiceName — same shape as
    // serviceCloudflareStats above.
    const filters = toCloudflareFilters(payload);
    return CH.compile(Integrations.cloudflareZoneLatencySQL(), params, {
      rowSchema: Integrations.cloudflareZoneLatencyRowSchema,
    });
  },
});

const cloudflareInfraZoneFirewallTimeseries = defineQuery({
  id: "cloudflareInfraZoneFirewallTimeseries",
  profile: "aggregation",
  cache: 15,
  compile: (payload: CloudflareInfraZoneSecurityRequest, orgId: string) => {
    const params = {
      orgId: orgId,
      serviceName: payload.serviceName,
      startTime: payload.startTime,
      endTime: payload.endTime,
    };
    const filters = toCloudflareFilters(payload);
    return CH.compile(
      Integrations.cloudflareZoneFirewallTimeseriesSQL(filters),
      { ...params, bucketSeconds: payload.bucketSeconds },
      { rowSchema: Integrations.cloudflareZoneFirewallTimeseriesRowSchema },
    );
  },
});

const cloudflareInfraZoneFirewallTop = defineQuery({
  id: "cloudflareInfraZoneFirewallTop",
  profile: "aggregation",
  cache: 15,
  compile: (payload: CloudflareInfraZoneSecurityRequest, orgId: string) => {
    const params = {
      orgId: orgId,
      serviceName: payload.serviceName,
      startTime: payload.startTime,
      endTime: payload.endTime,
    };
    const filters = toCloudflareFilters(payload);
    return CH.compile(Integrations.cloudflareZoneFirewallTopSQL(filters), params, {
      rowSchema: Integrations.cloudflareZoneFirewallTopRowSchema,
    });
  },
});

const cloudflareInfraZoneDnsTimeseries = defineQuery({
  id: "cloudflareInfraZoneDnsTimeseries",
  profile: "aggregation",
  cache: 15,
  compile: (payload: CloudflareInfraZoneDnsRequest, orgId: string) => {
    const params = {
      orgId: orgId,
      serviceName: payload.serviceName,
      startTime: payload.startTime,
      endTime: payload.endTime,
    };
    const filters = toCloudflareFilters(payload);
    return CH.compile(
      Integrations.cloudflareZoneDnsTimeseriesSQL(filters),
      { ...params, bucketSeconds: payload.bucketSeconds },
      { rowSchema: Integrations.cloudflareZoneDnsTimeseriesRowSchema },
    );
  },
});

const cloudflareInfraZoneDnsBreakdown = defineQuery({
  id: "cloudflareInfraZoneDnsBreakdown",
  profile: "aggregation",
  cache: 15,
  compile: (payload: CloudflareInfraZoneDnsRequest, orgId: string) => {
    const params = {
      orgId: orgId,
      serviceName: payload.serviceName,
      startTime: payload.startTime,
      endTime: payload.endTime,
    };
    const filters = toCloudflareFilters(payload);
    return CH.compile(Integrations.cloudflareZoneDnsBreakdownSQL(filters), params, {
      rowSchema: Integrations.cloudflareZoneDnsBreakdownRowSchema,
    });
  },
});

const cloudflareInfraWorkerCounters = defineQuery({
  id: "cloudflareInfraWorkerCounters",
  profile: "aggregation",
  cache: 15,
  compile: (payload: CloudflareInfraWorkersRequest, orgId: string) => {
    const params = {
      orgId: orgId,
      startTime: payload.startTime,
      endTime: payload.endTime,
    };
    return CH.compile(Integrations.cloudflareWorkerCountersSQL(), params, {
      rowSchema: Integrations.cloudflareWorkerCountersRowSchema,
    });
  },
});

const cloudflareInfraWorkerLatency = defineQuery({
  id: "cloudflareInfraWorkerLatency",
  profile: "aggregation",
  cache: 15,
  compile: (payload: CloudflareInfraWorkersRequest, orgId: string) => {
    const params = {
      orgId: orgId,
      startTime: payload.startTime,
      endTime: payload.endTime,
    };
    return CH.compile(Integrations.cloudflareWorkerLatencySQL(), params, {
      rowSchema: Integrations.cloudflareWorkerLatencyRowSchema,
    });
  },
});

const cloudflareInfraQueueGauges = defineQuery({
  id: "cloudflareInfraQueueGauges",
  profile: "aggregation",
  cache: 15,
  compile: (payload: CloudflareInfraPlatformResourcesRequest, orgId: string) => {
    const params = {
      orgId: orgId,
      startTime: payload.startTime,
      endTime: payload.endTime,
    };
    return CH.compile(Integrations.cloudflareQueueGaugesSQL(), params, {
      rowSchema: Integrations.cloudflareQueueGaugesRowSchema,
    });
  },
});

const cloudflareInfraDurableObjects = defineQuery({
  id: "cloudflareInfraDurableObjects",
  profile: "aggregation",
  cache: 15,
  compile: (payload: CloudflareInfraPlatformResourcesRequest, orgId: string) => {
    const params = {
      orgId: orgId,
      startTime: payload.startTime,
      endTime: payload.endTime,
    };
    return CH.compile(Integrations.cloudflareDurableObjectCountersSQL(), params, {
      rowSchema: Integrations.cloudflareDurableObjectCountersRowSchema,
    });
  },
});

const cloudflareServiceCounters = defineQuery({
  id: "cloudflareServiceCounters",
  profile: "aggregation",
  cache: 15,
  compile: (payload: ServiceCloudflareStatsRequest, orgId: string) => {
    const params = {
      orgId: orgId,
      startTime: payload.startTime,
      endTime: payload.endTime,
    };
    // Counters (metrics_sum) + percentiles (metrics_gauge) run
    // concurrently, then merge by ServiceName. Routed through the org's
    // configured warehouse exactly like the metric explorer reads these
    // same `cloudflare.*` metrics — no special ingest pin needed.
    return CH.compile(Integrations.cloudflareServiceCountersSQL(), params, {
      rowSchema: Integrations.cloudflareServiceCountersRowSchema,
    });
  },
});

const cloudflareServiceLatency = defineQuery({
  id: "cloudflareServiceLatency",
  profile: "aggregation",
  cache: 15,
  compile: (payload: ServiceCloudflareStatsRequest, orgId: string) => {
    const params = {
      orgId: orgId,
      startTime: payload.startTime,
      endTime: payload.endTime,
    };
    // Counters (metrics_sum) + percentiles (metrics_gauge) run
    // concurrently, then merge by ServiceName. Routed through the org's
    // configured warehouse exactly like the metric explorer reads these
    // same `cloudflare.*` metrics — no special ingest pin needed.
    return CH.compile(Integrations.cloudflareServiceLatencySQL(), params, {
      rowSchema: Integrations.cloudflareServiceLatencyRowSchema,
    });
  },
});

const planetscaleInfraTimeseries = defineQuery({
  id: "planetscaleInfraTimeseries",
  profile: "aggregation",
  cache: 15,
  compile: (payload: PlanetScaleInfraTimeseriesRequest, orgId: string) => {
    const base = {
      orgId: orgId,
      startTime: payload.startTime,
      endTime: payload.endTime,
      bucketSeconds: Math.max(60, Math.floor(payload.bucketSeconds)),
      database: payload.database,
    };
    return payload.branch === undefined
      ? CH.compile(Integrations.planetscaleInfraTimeseriesSQL(), base, {
          rowSchema: Integrations.planetscaleInfraTimeseriesRowSchema,
        })
      : CH.compile(
          Integrations.planetscaleBranchInfraTimeseriesSQL(),
          { ...base, branch: payload.branch },
          { rowSchema: Integrations.planetscaleInfraTimeseriesRowSchema },
        );
  },
});

const zoneDetailParams = (payload: CloudflareInfraZoneDetailRequest, orgId: string) => ({
  orgId,
  serviceName: payload.serviceName,
  startTime: payload.startTime,
  endTime: payload.endTime,
  bucketSeconds: payload.bucketSeconds,
});

const cloudflareInfraZoneDetailStatus = defineQuery({
  id: "cloudflareInfraZoneDetailStatus",
  profile: "aggregation",
  cache: 15,
  compile: (payload: CloudflareInfraZoneDetailRequest, orgId: string) =>
    CH.compile(
      Integrations.cloudflareZoneStatusTimeseriesSQL(toCloudflareFilters(payload)),
      zoneDetailParams(payload, orgId),
      { rowSchema: Integrations.cloudflareZoneStatusTimeseriesRowSchema },
    ),
});

const cloudflareInfraZoneDetailCache = defineQuery({
  id: "cloudflareInfraZoneDetailCache",
  profile: "aggregation",
  cache: 15,
  compile: (payload: CloudflareInfraZoneDetailRequest, orgId: string) =>
    CH.compile(
      Integrations.cloudflareZoneCacheTimeseriesSQL(toCloudflareFilters(payload)),
      zoneDetailParams(payload, orgId),
      { rowSchema: Integrations.cloudflareZoneCacheTimeseriesRowSchema },
    ),
});

/** Latency comes from a gauge family that honors no request filters — hence the no-arg SQL. */
const cloudflareInfraZoneDetailLatency = defineQuery({
  id: "cloudflareInfraZoneDetailLatency",
  profile: "aggregation",
  cache: 15,
  compile: (payload: CloudflareInfraZoneDetailRequest, orgId: string) =>
    CH.compile(
      Integrations.cloudflareZoneLatencyTimeseriesSQL(),
      zoneDetailParams(payload, orgId),
      {
        rowSchema: Integrations.cloudflareZoneLatencyTimeseriesRowSchema,
      },
    ),
});

// Each reads either the database-level or the branch-level rollup depending on
// whether a database was requested. The branch lives inside `compile` so the id,
// profile and row schema stay one decision per sub-query rather than two.

const planetscaleStatsParams = (payload: ServicePlanetScaleStatsRequest, orgId: string) => ({
  orgId,
  startTime: payload.startTime,
  endTime: payload.endTime,
  ...(payload.database !== undefined ? { database: payload.database } : undefined),
});

const planetscaleServiceGauges = defineQuery({
  id: "planetscaleServiceGauges",
  profile: "aggregation",
  cache: 15,
  compile: (payload: ServicePlanetScaleStatsRequest, orgId: string) => {
    const params = planetscaleStatsParams(payload, orgId);
    return payload.database !== undefined
      ? CH.compile(Integrations.planetscaleBranchGaugesSQL(), params, {
          rowSchema: Integrations.planetscaleBranchStatsRowSchema,
        })
      : CH.compile(Integrations.planetscaleGaugesSQL(), params, {
          rowSchema: Integrations.planetscaleDatabaseStatsRowSchema,
        });
  },
});

const planetscaleServiceConnections = defineQuery({
  id: "planetscaleServiceConnections",
  profile: "aggregation",
  cache: 15,
  compile: (payload: ServicePlanetScaleStatsRequest, orgId: string) => {
    const params = planetscaleStatsParams(payload, orgId);
    return payload.database !== undefined
      ? CH.compile(Integrations.planetscaleBranchConnectionsSQL(), params, {
          rowSchema: Integrations.planetscaleBranchConnectionsRowSchema,
        })
      : CH.compile(Integrations.planetscaleConnectionsSQL(), params, {
          rowSchema: Integrations.planetscaleConnectionsRowSchema,
        });
  },
});

const planetscaleServiceStorage = defineQuery({
  id: "planetscaleServiceStorage",
  profile: "aggregation",
  cache: 15,
  compile: (payload: ServicePlanetScaleStatsRequest, orgId: string) => {
    const params = planetscaleStatsParams(payload, orgId);
    return payload.database !== undefined
      ? CH.compile(Integrations.planetscaleBranchStorageSQL(), params, {
          rowSchema: Integrations.planetscaleBranchStorageRowSchema,
        })
      : CH.compile(Integrations.planetscaleStorageSQL(), params, {
          rowSchema: Integrations.planetscaleStorageRowSchema,
        });
  },
});

/**
 * Zone facet counts: 8 UNION branches over the wide Attributes Map column.
 * maxThreads caps read-thread concurrency so per-thread decompression buffers
 * stay inside the discovery memory budget — same guard as podFacets.
 */
const cloudflareInfraZoneFacets = defineQuery({
  id: "cloudflareInfraZoneFacets",
  profile: "discovery",
  settings: { maxThreads: 4 },
  cache: 60,
  compile: (payload: CloudflareInfraZoneFacetsRequest, orgId: string) =>
    CH.compileUnion(Integrations.cloudflareZoneFacetsQuery(toCloudflareFilters(payload)), {
      orgId,
      serviceName: payload.serviceName,
      startTime: payload.startTime,
      endTime: payload.endTime,
    }),
});

// Network reads a counter family, everything else a gauge family, so they are
// separate defs rather than one def with a branch — the row shapes differ and
// the handler maps them differently. Both keep the id "hostInfraTimeseries",
// which is what their spans already report; renaming would break continuity of
// existing telemetry for no gain.

const hostInfraNetworkTimeseries = defineQuery({
  id: "hostInfraTimeseries",
  profile: "aggregation",
  cache: 15,
  compile: (payload: HostInfraTimeseriesRequest, orgId: string) =>
    CH.compile(CH.hostNetworkTimeseriesQuery({ hostName: payload.hostName }), {
      orgId,
      startTime: payload.startTime,
      endTime: payload.endTime,
      bucketSeconds: payload.bucketSeconds ?? 60,
    }),
});

const hostInfraGaugeTimeseries = defineQuery({
  id: "hostInfraTimeseries",
  profile: "aggregation",
  cache: 15,
  compile: (payload: HostInfraTimeseriesRequest, orgId: string) => {
    const spec = hostMetricSpec(payload.metric);
    return CH.compile(
      CH.hostGaugeTimeseriesQuery({
        hostName: payload.hostName,
        metricName: spec.metricName,
        groupByAttributeKey: spec.groupByAttributeKey,
      }),
      {
        orgId,
        startTime: payload.startTime,
        endTime: payload.endTime,
        bucketSeconds: payload.bucketSeconds ?? 60,
      },
    );
  },
});

const zoneBreakdownParams = (payload: CloudflareInfraZoneBreakdownRequest, orgId: string) => ({
  orgId,
  serviceName: payload.serviceName,
  startTime: payload.startTime,
  endTime: payload.endTime,
});

const cloudflareInfraZoneBreakdownTotals = defineQuery({
  id: "cloudflareInfraZoneBreakdownTotals",
  profile: "aggregation",
  cache: 15,
  compile: (payload: CloudflareInfraZoneBreakdownRequest, orgId: string) => {
    return CH.compile(
      Integrations.cloudflareZoneBreakdownTotalsSQL(
        payload.dimension,
        toCloudflareFilters(payload),
        payload.limit ?? 100,
      ),
      zoneBreakdownParams(payload, orgId),
      { rowSchema: Integrations.cloudflareZoneBreakdownTotalsRowSchema },
    );
  },
});

/**
 * Coverage is deliberately UNFILTERED: it answers "what did the poller collect
 * here", which the UI needs in order to say "not collected yet" rather than "no
 * traffic" for a window that predates the dataset. Do not thread filters in.
 */
const cloudflareInfraZoneBreakdownCoverage = defineQuery({
  id: "cloudflareInfraZoneBreakdownCoverage",
  profile: "aggregation",
  cache: 15,
  compile: (payload: CloudflareInfraZoneBreakdownRequest, orgId: string) =>
    CH.compile(
      Integrations.cloudflareZoneBreakdownCoverageSQL(payload.dimension),
      zoneBreakdownParams(payload, orgId),
      { rowSchema: Integrations.cloudflareZoneBreakdownCoverageRowSchema },
    ),
});

const cloudflareInfraZoneBreakdownZoneTotal = defineQuery({
  id: "cloudflareInfraZoneBreakdownZoneTotal",
  profile: "aggregation",
  cache: 15,
  compile: (payload: CloudflareInfraZoneBreakdownRequest, orgId: string) =>
    CH.compile(
      Integrations.cloudflareZoneCountersSQL(toCloudflareFilters(payload)),
      zoneBreakdownParams(payload, orgId),
      { rowSchema: Integrations.cloudflareZoneCountersRowSchema },
    ),
});

/**
 * The chart runs AFTER the totals rather than beside them: totals are already
 * ranked by requests, so they name the series worth plotting. Without that the
 * grouping is unbounded — a zone taking scanner traffic returns a distinct path
 * per probe, and the response grows to buckets x thousands of keys. One extra
 * round trip over the same warm scan buys a payload that can't blow up.
 *
 * `topKeys` therefore rides in the PAYLOAD rather than being derived inside
 * `compile`: it is the output of a previous query, which a def has no way to
 * see. The caller must also skip this entirely when `topKeys` is empty.
 */
const cloudflareInfraZoneBreakdownTimeseries = defineQuery({
  id: "cloudflareInfraZoneBreakdownTimeseries",
  profile: "aggregation",
  cache: 15,
  compile: (
    payload: CloudflareInfraZoneBreakdownRequest & { readonly topKeys: ReadonlyArray<string> },
    orgId: string,
  ) =>
    CH.compile(
      Integrations.cloudflareZoneBreakdownTimeseriesSQL(
        payload.dimension,
        toCloudflareFilters(payload),
        payload.topKeys,
      ),
      { ...zoneBreakdownParams(payload, orgId), bucketSeconds: payload.bucketSeconds },
      { rowSchema: Integrations.cloudflareZoneBreakdownTimeseriesRowSchema },
    ),
});

export const Queries = {
  ...Core,

  /**
   * Bounded to a ±1h window around the requested log so ClickHouse can prune
   * partitions instead of reading every retained daily partition for an
   * exact-timestamp match. That window used to be computed in the handler.
   */
  getLog: defineQuery({
    id: "getLog",
    profile: "list",
    cache: 15,
    compile: (payload: GetLogRequest, orgId: string) => {
      const { startTime, endTime } = partitionWindowAround(payload.timestamp);
      return CH.compile(
        CH.getLogByKeyQuery({
          serviceName: payload.serviceName,
          traceId: payload.traceId,
          spanId: payload.spanId,
        }),
        { orgId, startTime, endTime, timestamp: payload.timestamp },
      );
    },
  }),

  /**
   * A finished trace is immutable and cacheable; one still receiving spans is
   * not. `traceCacheTtlSeconds` decides from the requested end time against
   * now, which is why this def takes the dynamic-cache form.
   */
  spanDetail: defineQuery({
    id: "spanDetail",
    profile: "discovery",
    cache: (payload: SpanDetailRequest, nowMs: number) =>
      traceCacheTtlSeconds(payload.endTime, nowMs),
    compile: (payload: SpanDetailRequest, orgId: string) => {
      // Without both bounds there is no window to narrow to, and passing a
      // half-open range would widen the scan rather than prune it.
      const narrowByTime = payload.startTime != null && payload.endTime != null;
      return CH.compile(
        CH.spanDetailQuery({
          traceId: payload.traceId,
          spanId: payload.spanId,
          narrowByTime,
        }),
        narrowByTime
          ? { orgId, startTime: payload.startTime, endTime: payload.endTime }
          : { orgId },
      );
    },
  }),

  fleetUtilizationTimeseries: defineQuery({
    id: "fleetUtilizationTimeseries",
    profile: "aggregation",
    cache: 15,
    compile: (payload: FleetUtilizationTimeseriesRequest, orgId: string) =>
      CH.compile(CH.fleetUtilizationTimeseriesQuery(), {
        orgId,
        startTime: payload.startTime,
        endTime: payload.endTime,
        bucketSeconds: payload.bucketSeconds ?? 300,
      }),
  }),

  podInfraTimeseries: defineQuery({
    id: "podInfraTimeseries",
    profile: "aggregation",
    cache: 15,
    compile: (payload: PodInfraTimeseriesRequest, orgId: string) =>
      CH.compile(
        CH.podGaugeTimeseriesQuery({
          podName: payload.podName,
          namespace: payload.namespace,
          metricName: podMetricSpec(payload.metric).metricName,
        }),
        {
          orgId,
          startTime: payload.startTime,
          endTime: payload.endTime,
          bucketSeconds: payload.bucketSeconds ?? 60,
        },
      ),
  }),

  nodeInfraTimeseries: defineQuery({
    id: "nodeInfraTimeseries",
    profile: "aggregation",
    cache: 15,
    compile: (payload: NodeInfraTimeseriesRequest, orgId: string) =>
      CH.compile(
        CH.nodeGaugeTimeseriesQuery({
          nodeName: payload.nodeName,
          metricName: nodeMetricSpec(payload.metric).metricName,
        }),
        {
          orgId,
          startTime: payload.startTime,
          endTime: payload.endTime,
          bucketSeconds: payload.bucketSeconds ?? 60,
        },
      ),
  }),

  workloadInfraTimeseries: defineQuery({
    id: "workloadInfraTimeseries",
    profile: "aggregation",
    cache: 15,
    compile: (payload: WorkloadInfraTimeseriesRequest, orgId: string) =>
      CH.compile(
        CH.workloadGaugeTimeseriesQuery({
          kind: payload.kind,
          workloadName: payload.workloadName,
          namespace: payload.namespace,
          metricName: workloadMetricSpec(payload.metric).metricName,
          groupByPod: payload.groupByPod,
        }),
        {
          orgId,
          startTime: payload.startTime,
          endTime: payload.endTime,
          bucketSeconds: payload.bucketSeconds ?? 60,
        },
      ),
  }),

  cloudflareInfraZoneTimeseries: defineQuery({
    id: "cloudflareInfraZoneTimeseries",
    profile: "aggregation",
    cache: 15,
    compile: (payload: CloudflareInfraZoneTimeseriesRequest, orgId: string) =>
      CH.compile(
        Integrations.cloudflareZoneTimeseriesSQL(toCloudflareFilters(payload)),
        {
          orgId,
          startTime: payload.startTime,
          endTime: payload.endTime,
          bucketSeconds: payload.bucketSeconds,
        },
        { rowSchema: Integrations.cloudflareZoneTimeseriesRowSchema },
      ),
  }),

  // Integration queries, declared above.
  cloudflareInfraZoneCounters,
  cloudflareInfraZoneLatency,
  cloudflareInfraZoneFirewallTimeseries,
  cloudflareInfraZoneFirewallTop,
  cloudflareInfraZoneDnsTimeseries,
  cloudflareInfraZoneDnsBreakdown,
  cloudflareInfraWorkerCounters,
  cloudflareInfraWorkerLatency,
  cloudflareInfraQueueGauges,
  cloudflareInfraDurableObjects,
  cloudflareServiceCounters,
  cloudflareServiceLatency,
  planetscaleInfraTimeseries,

  // ZoneDetail / PlanetScaleStats sub-queries, declared above.
  cloudflareInfraZoneDetailStatus,
  cloudflareInfraZoneDetailCache,
  cloudflareInfraZoneDetailLatency,
  planetscaleServiceGauges,
  planetscaleServiceConnections,
  planetscaleServiceStorage,
  cloudflareInfraZoneFacets,
  hostInfraNetworkTimeseries,
  hostInfraGaugeTimeseries,
  cloudflareInfraZoneBreakdownTotals,
  cloudflareInfraZoneBreakdownCoverage,
  cloudflareInfraZoneBreakdownZoneTotal,
  cloudflareInfraZoneBreakdownTimeseries,
} as const;
