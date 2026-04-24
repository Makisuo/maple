import { describe, expect, it } from "vitest"
import { compileCH } from "../compile"
import {
  listHostsQuery,
  hostDetailSummaryQuery,
  listPodsQuery,
  podDetailSummaryQuery,
  podGaugeTimeseriesQuery,
  listNodesQuery,
  nodeDetailSummaryQuery,
  nodeGaugeTimeseriesQuery,
  listWorkloadsQuery,
  workloadDetailSummaryQuery,
  workloadGaugeTimeseriesQuery,
} from "./infra"

const baseParams = {
  orgId: "org_1",
  startTime: "2024-01-01 00:00:00",
  endTime: "2024-01-02 00:00:00",
  bucketSeconds: 60,
}

describe("listHostsQuery (sanity)", () => {
  it("compiles with required filters", () => {
    const { sql } = compileCH(listHostsQuery({}), baseParams)
    expect(sql).toContain("FROM metrics_gauge")
    expect(sql).toContain("OrgId = 'org_1'")
    expect(sql).toContain("ResourceAttributes['host.name']")
    expect(sql).not.toMatch(/__PARAM_\w+__/)
  })
})

describe("hostDetailSummaryQuery (sanity)", () => {
  it("filters by hostName", () => {
    const { sql } = compileCH(
      hostDetailSummaryQuery({ hostName: "host-1" }),
      baseParams,
    )
    expect(sql).toContain("ResourceAttributes['host.name']")
    expect(sql).toContain("'host-1'")
  })
})

// ---------------------------------------------------------------------------
// Pods
// ---------------------------------------------------------------------------

describe("listPodsQuery", () => {
  it("compiles with required filters and pod metric whitelist", () => {
    const { sql } = compileCH(listPodsQuery({}), baseParams)
    expect(sql).toContain("FROM metrics_gauge")
    expect(sql).toContain("OrgId = 'org_1'")
    expect(sql).toContain("ResourceAttributes['k8s.pod.name']")
    expect(sql).toContain("k8s.pod.cpu.usage")
    expect(sql).toContain("k8s.pod.cpu_limit_utilization")
    expect(sql).toContain("k8s.pod.memory_limit_utilization")
    expect(sql).toContain("LIMIT 200")
    expect(sql).toContain("FORMAT JSON")
    expect(sql).not.toMatch(/__PARAM_\w+__/)
  })

  it("applies search, namespace, and node filters", () => {
    const { sql } = compileCH(
      listPodsQuery({
        search: "auth",
        namespace: "prod",
        nodeName: "node-7",
      }),
      baseParams,
    )
    expect(sql.toLowerCase()).toContain("position")
    expect(sql).toContain("'auth'")
    expect(sql).toContain("'prod'")
    expect(sql).toContain("'node-7'")
  })

  it("applies workload filter when both kind+name supplied", () => {
    const { sql } = compileCH(
      listPodsQuery({
        workloadKind: "deployment",
        workloadName: "checkout",
      }),
      baseParams,
    )
    expect(sql).toContain("ResourceAttributes['k8s.deployment.name']")
    expect(sql).toContain("'checkout'")
  })

  it("respects custom limit/offset", () => {
    const { sql } = compileCH(
      listPodsQuery({ limit: 50, offset: 25 }),
      baseParams,
    )
    expect(sql).toContain("LIMIT 50")
    expect(sql).toContain("OFFSET 25")
  })
})

describe("podDetailSummaryQuery", () => {
  it("filters by pod name and aggregates request+limit utilization", () => {
    const { sql } = compileCH(
      podDetailSummaryQuery({ podName: "pod-xyz", namespace: "prod" }),
      baseParams,
    )
    expect(sql).toContain("'pod-xyz'")
    expect(sql).toContain("'prod'")
    expect(sql).toContain("k8s.pod.cpu_request_utilization")
    expect(sql).toContain("k8s.pod.memory_request_utilization")
  })
})

describe("podGaugeTimeseriesQuery", () => {
  it("buckets by toStartOfInterval and filters by metric name", () => {
    const { sql } = compileCH(
      podGaugeTimeseriesQuery({
        podName: "pod-xyz",
        metricName: "k8s.pod.cpu.usage",
      }),
      baseParams,
    )
    expect(sql).toContain("toStartOfInterval")
    expect(sql).toContain("INTERVAL 60 SECOND")
    expect(sql).toContain("MetricName = 'k8s.pod.cpu.usage'")
  })
})

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

describe("listNodesQuery", () => {
  it("filters out pod-scoped rows so node aggregates are clean", () => {
    const { sql } = compileCH(listNodesQuery({}), baseParams)
    expect(sql).toContain("ResourceAttributes['k8s.node.name']")
    expect(sql).toContain("ResourceAttributes['k8s.pod.name'] = ''")
    expect(sql).toContain("k8s.node.cpu.usage")
    expect(sql).toContain("k8s.node.uptime")
    expect(sql).not.toMatch(/__PARAM_\w+__/)
  })
})

describe("nodeDetailSummaryQuery", () => {
  it("filters by node name", () => {
    const { sql } = compileCH(
      nodeDetailSummaryQuery({ nodeName: "node-7" }),
      baseParams,
    )
    expect(sql).toContain("'node-7'")
    expect(sql).toContain("ResourceAttributes['k8s.pod.name'] = ''")
  })
})

describe("nodeGaugeTimeseriesQuery", () => {
  it("compiles bucketed node timeseries", () => {
    const { sql } = compileCH(
      nodeGaugeTimeseriesQuery({
        nodeName: "node-7",
        metricName: "k8s.node.cpu.usage",
      }),
      baseParams,
    )
    expect(sql).toContain("toStartOfInterval")
    expect(sql).toContain("MetricName = 'k8s.node.cpu.usage'")
    expect(sql).toContain("'node-7'")
  })
})

// ---------------------------------------------------------------------------
// Workloads
// ---------------------------------------------------------------------------

describe("listWorkloadsQuery", () => {
  it("groups by k8s.deployment.name when kind = deployment", () => {
    const { sql } = compileCH(
      listWorkloadsQuery({ kind: "deployment" }),
      baseParams,
    )
    expect(sql).toContain("ResourceAttributes['k8s.deployment.name']")
    expect(sql).toContain("uniq")
  })

  it("uses the right attribute for statefulset and daemonset", () => {
    const sts = compileCH(
      listWorkloadsQuery({ kind: "statefulset" }),
      baseParams,
    ).sql
    expect(sts).toContain("ResourceAttributes['k8s.statefulset.name']")
    const ds = compileCH(
      listWorkloadsQuery({ kind: "daemonset" }),
      baseParams,
    ).sql
    expect(ds).toContain("ResourceAttributes['k8s.daemonset.name']")
  })
})

describe("workloadDetailSummaryQuery", () => {
  it("filters by workload name and namespace", () => {
    const { sql } = compileCH(
      workloadDetailSummaryQuery({
        kind: "deployment",
        workloadName: "checkout",
        namespace: "prod",
      }),
      baseParams,
    )
    expect(sql).toContain("'checkout'")
    expect(sql).toContain("'prod'")
  })
})

describe("workloadGaugeTimeseriesQuery", () => {
  it("includes per-pod breakdown when groupByPod = true", () => {
    const { sql } = compileCH(
      workloadGaugeTimeseriesQuery({
        kind: "deployment",
        workloadName: "checkout",
        metricName: "k8s.pod.cpu_limit_utilization",
        groupByPod: true,
      }),
      baseParams,
    )
    expect(sql).toContain("ResourceAttributes['k8s.pod.name']")
    expect(sql).toContain("GROUP BY")
  })

  it("aggregates across pods when groupByPod = false", () => {
    const { sql } = compileCH(
      workloadGaugeTimeseriesQuery({
        kind: "deployment",
        workloadName: "checkout",
        metricName: "k8s.pod.cpu_limit_utilization",
      }),
      baseParams,
    )
    expect(sql).toContain("toStartOfInterval")
  })
})
