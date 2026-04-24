import { describe, expect, it } from "vitest"
import { compileCH } from "../compile"
import { compileUnion } from "../compile"
import {
  listHostsQuery,
  hostDetailSummaryQuery,
  listPodsQuery,
  podDetailSummaryQuery,
  podGaugeTimeseriesQuery,
  podFacetsQuery,
  listNodesQuery,
  nodeDetailSummaryQuery,
  nodeGaugeTimeseriesQuery,
  nodeFacetsQuery,
  listWorkloadsQuery,
  workloadDetailSummaryQuery,
  workloadGaugeTimeseriesQuery,
  workloadFacetsQuery,
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
    expect(sql).toContain("k8s.pod.cpu_request_utilization")
    expect(sql).toContain("k8s.pod.memory_request_utilization")
    expect(sql).toContain("LIMIT 200")
    expect(sql).toContain("FORMAT JSON")
    expect(sql).not.toMatch(/__PARAM_\w+__/)
  })

  it("applies search and single-node legacy filters", () => {
    const { sql } = compileCH(
      listPodsQuery({
        search: "auth",
        namespaces: ["prod"],
        nodeNames: ["node-7"],
      }),
      baseParams,
    )
    expect(sql.toLowerCase()).toContain("position")
    expect(sql).toContain("'auth'")
    expect(sql).toContain("'prod'")
    expect(sql).toContain("'node-7'")
  })

  it("applies multi-value array filters with IN clauses", () => {
    const { sql } = compileCH(
      listPodsQuery({
        namespaces: ["prod", "stage"],
        nodeNames: ["node-1", "node-2"],
        clusters: ["c1"],
        deployments: ["api", "web"],
        environments: ["production"],
      }),
      baseParams,
    )
    expect(sql).toContain("ResourceAttributes['k8s.namespace.name'] IN")
    expect(sql).toContain("'prod'")
    expect(sql).toContain("'stage'")
    expect(sql).toContain("ResourceAttributes['k8s.node.name'] IN")
    expect(sql).toContain("ResourceAttributes['k8s.cluster.name'] IN")
    expect(sql).toContain("ResourceAttributes['k8s.deployment.name'] IN")
    expect(sql).toContain("ResourceAttributes['deployment.environment.name'] IN")
    expect(sql).toContain("'production'")
  })

  it("filters by pod, statefulset, daemonset, and job names when arrays present", () => {
    const { sql } = compileCH(
      listPodsQuery({
        podNames: ["pod-a"],
        statefulsets: ["sts-x"],
        daemonsets: ["ds-y"],
        jobs: ["job-z"],
      }),
      baseParams,
    )
    expect(sql).toContain("ResourceAttributes['k8s.pod.name'] IN")
    expect(sql).toContain("ResourceAttributes['k8s.statefulset.name'] IN")
    expect(sql).toContain("ResourceAttributes['k8s.daemonset.name'] IN")
    expect(sql).toContain("ResourceAttributes['k8s.job.name'] IN")
  })

  it("applies workload filter when both kind+name supplied (legacy)", () => {
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

describe("podFacetsQuery", () => {
  it("emits a UNION ALL with one branch per facet dimension", () => {
    const { sql } = compileUnion(podFacetsQuery({}), baseParams)
    expect(sql.toUpperCase().split("UNION ALL").length).toBeGreaterThan(2)
    expect(sql).toContain("ResourceAttributes['k8s.pod.name']")
    expect(sql).toContain("ResourceAttributes['k8s.namespace.name']")
    expect(sql).toContain("ResourceAttributes['k8s.node.name']")
    expect(sql).toContain("ResourceAttributes['k8s.cluster.name']")
    expect(sql).toContain("ResourceAttributes['k8s.deployment.name']")
    expect(sql).toContain("ResourceAttributes['k8s.statefulset.name']")
    expect(sql).toContain("ResourceAttributes['k8s.daemonset.name']")
    expect(sql).toContain("ResourceAttributes['k8s.job.name']")
    expect(sql).toContain("ResourceAttributes['deployment.environment.name']")
    expect(sql).toContain("FORMAT JSON")
  })

  it("propagates active filters into facet counts", () => {
    const { sql } = compileUnion(
      podFacetsQuery({ namespaces: ["prod"] }),
      baseParams,
    )
    expect(sql).toContain("'prod'")
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

  it("applies cluster/environment array filters", () => {
    const { sql } = compileCH(
      listNodesQuery({
        clusters: ["c1", "c2"],
        environments: ["production"],
      }),
      baseParams,
    )
    expect(sql).toContain("ResourceAttributes['k8s.cluster.name'] IN")
    expect(sql).toContain("ResourceAttributes['deployment.environment.name'] IN")
  })
})

describe("nodeFacetsQuery", () => {
  it("emits node, cluster, and environment facet branches", () => {
    const { sql } = compileUnion(nodeFacetsQuery({}), baseParams)
    expect(sql.toUpperCase().split("UNION ALL").length).toBeGreaterThan(2)
    expect(sql).toContain("ResourceAttributes['k8s.node.name']")
    expect(sql).toContain("ResourceAttributes['k8s.cluster.name']")
    expect(sql).toContain("ResourceAttributes['deployment.environment.name']")
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

  it("applies workloadNames + namespaces + clusters filters", () => {
    const { sql } = compileCH(
      listWorkloadsQuery({
        kind: "deployment",
        workloadNames: ["api"],
        namespaces: ["prod"],
        clusters: ["c1"],
        environments: ["production"],
      }),
      baseParams,
    )
    expect(sql).toContain("ResourceAttributes['k8s.deployment.name'] IN")
    expect(sql).toContain("ResourceAttributes['k8s.namespace.name'] IN")
    expect(sql).toContain("ResourceAttributes['k8s.cluster.name'] IN")
    expect(sql).toContain("ResourceAttributes['deployment.environment.name'] IN")
  })
})

describe("workloadFacetsQuery", () => {
  it("emits workload, namespace, cluster, environment branches scoped to kind", () => {
    const { sql } = compileUnion(
      workloadFacetsQuery({ kind: "deployment" }),
      baseParams,
    )
    expect(sql).toContain("ResourceAttributes['k8s.deployment.name']")
    expect(sql).toContain("ResourceAttributes['k8s.namespace.name']")
    expect(sql).toContain("ResourceAttributes['k8s.cluster.name']")
    expect(sql).toContain("ResourceAttributes['deployment.environment.name']")
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
