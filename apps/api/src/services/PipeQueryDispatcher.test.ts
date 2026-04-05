import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { OrgId } from "@maple/domain/http"
import { compilePipeQuery } from "./PipeQueryDispatcher"

const asOrgId = Schema.decodeUnknownSync(OrgId)

const baseParams = () => ({
  org_id: asOrgId("test-org"),
  start_time: "2024-01-01 00:00:00",
  end_time: "2024-01-02 00:00:00",
})

describe("compilePipeQuery", () => {
  describe("returns compiled SQL for known pipes", () => {
    const knownPipes = [
      "list_traces",
      "span_hierarchy",
      "traces_duration_stats",
      "traces_facets",
      "list_logs",
      "logs_count",
      "logs_facets",
      "error_rate_by_service",
      "service_overview",
      "services_facets",
      "service_releases_timeline",
      "service_apdex_time_series",
      "get_service_usage",
      "service_dependencies",
      "errors_by_type",
      "errors_timeseries",
      "errors_facets",
      "errors_summary",
      "error_detail_traces",
      "list_metrics",
      "metrics_summary",
      "span_attribute_keys",
      "resource_attribute_keys",
      "metric_attribute_keys",
      "span_attribute_values",
      "resource_attribute_values",
      "custom_traces_timeseries",
      "custom_traces_breakdown",
    ] as const

    for (const pipe of knownPipes) {
      it(pipe, () => {
        const result = compilePipeQuery(pipe, {
          ...baseParams(),
          trace_id: "abc123",
          service_name: "my-svc",
          error_type: "TypeError",
          attribute_key: "http.method",
          bucket_seconds: 60,
        })
        expect(result).toBeDefined()
        expect(result!.sql).toContain("test-org")
        expect(typeof result!.castRows).toBe("function")
      })
    }
  })

  it("returns undefined for unknown pipes", () => {
    const result = compilePipeQuery("nonexistent_pipe", baseParams())
    expect(result).toBeUndefined()
  })

  it("injects OrgId into SQL", () => {
    const result = compilePipeQuery("list_traces", baseParams())
    expect(result!.sql).toContain("test-org")
  })

  it("injects start_time and end_time into SQL", () => {
    const result = compilePipeQuery("list_traces", baseParams())
    expect(result!.sql).toContain("2024-01-01 00:00:00")
    expect(result!.sql).toContain("2024-01-02 00:00:00")
  })

  it("castRows passes through rows", () => {
    const result = compilePipeQuery("list_traces", baseParams())
    const rows = [{ traceId: "abc" }]
    expect(result!.castRows(rows)).toEqual(rows)
  })
})

describe("buildAttributeFiltersFromParams", () => {
  it("parses attribute filters with numbered suffixes", () => {
    const result = compilePipeQuery("custom_traces_timeseries", {
      ...baseParams(),
      attribute_filter_key: "http.method",
      attribute_filter_value: "GET",
      attribute_filter_key_2: "http.status_code",
      attribute_filter_value_2: "200",
    })
    expect(result).toBeDefined()
    expect(result!.sql).toContain("http.method")
    expect(result!.sql).toContain("GET")
    expect(result!.sql).toContain("http.status_code")
    expect(result!.sql).toContain("200")
  })

  it("parses resource filters with numbered suffixes", () => {
    const result = compilePipeQuery("custom_traces_timeseries", {
      ...baseParams(),
      resource_filter_key: "service.name",
      resource_filter_value: "api",
    })
    expect(result).toBeDefined()
    expect(result!.sql).toContain("service.name")
  })

  it("returns no filters when no filter keys present", () => {
    const result = compilePipeQuery("custom_traces_timeseries", baseParams())
    expect(result).toBeDefined()
    // Should compile without errors even with no filters
    expect(result!.sql).toBeTruthy()
  })

  it("handles exists mode filters", () => {
    const result = compilePipeQuery("custom_traces_timeseries", {
      ...baseParams(),
      attribute_filter_key: "http.method",
      attribute_filter_exists: "1",
    })
    expect(result).toBeDefined()
    expect(result!.sql).toContain("http.method")
  })
})
