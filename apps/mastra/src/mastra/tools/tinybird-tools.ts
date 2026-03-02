import { createTool } from "@mastra/core/tools"
import { z } from "zod"
import {
  fetchErrorsSummary,
  fetchErrorsByType,
  fetchServiceOverview,
  fetchServiceApdex,
  fetchErrorTraces,
  fetchSpanHierarchy,
  searchLogs,
} from "../lib/maple-client"

export const fetchErrorsSummaryTool = createTool({
  id: "fetch-errors-summary",
  description:
    "Fetch error summary metrics for an organization including error rate, total errors, and affected service count",
  inputSchema: z.object({
    orgId: z.string().describe("Organization ID"),
    startTime: z.string().describe("Start time in 'YYYY-MM-DD HH:mm:ss' format"),
    endTime: z.string().describe("End time in 'YYYY-MM-DD HH:mm:ss' format"),
  }),
  outputSchema: z.object({
    errorRate: z.number(),
    totalErrors: z.number(),
    affectedServicesCount: z.number(),
  }).nullable(),
  execute: async (input) => {
    return fetchErrorsSummary(input.orgId, input.startTime, input.endTime)
  },
})

export const fetchErrorsByTypeTool = createTool({
  id: "fetch-errors-by-type",
  description: "Fetch errors grouped by error type with counts and affected services",
  inputSchema: z.object({
    orgId: z.string().describe("Organization ID"),
    startTime: z.string().describe("Start time in 'YYYY-MM-DD HH:mm:ss' format"),
    endTime: z.string().describe("End time in 'YYYY-MM-DD HH:mm:ss' format"),
  }),
  outputSchema: z.array(
    z.object({
      errorType: z.string(),
      count: z.number(),
      affectedServices: z.array(z.string()),
    }),
  ),
  execute: async (input) => {
    return fetchErrorsByType(input.orgId, input.startTime, input.endTime)
  },
})

export const fetchServiceOverviewTool = createTool({
  id: "fetch-service-overview",
  description:
    "Fetch service-level metrics including P99 latency, error rate, and throughput for all services",
  inputSchema: z.object({
    orgId: z.string().describe("Organization ID"),
    startTime: z.string().describe("Start time in 'YYYY-MM-DD HH:mm:ss' format"),
    endTime: z.string().describe("End time in 'YYYY-MM-DD HH:mm:ss' format"),
  }),
  outputSchema: z.array(
    z.object({
      serviceName: z.string(),
      p99LatencyMs: z.number(),
      errorRate: z.number(),
      throughput: z.number(),
    }),
  ),
  execute: async (input) => {
    return fetchServiceOverview(input.orgId, input.startTime, input.endTime)
  },
})

export const fetchServiceApdexTool = createTool({
  id: "fetch-service-apdex",
  description: "Fetch Apdex score time series for a specific service",
  inputSchema: z.object({
    orgId: z.string().describe("Organization ID"),
    serviceName: z.string().describe("Service name"),
    startTime: z.string().describe("Start time in 'YYYY-MM-DD HH:mm:ss' format"),
    endTime: z.string().describe("End time in 'YYYY-MM-DD HH:mm:ss' format"),
    bucketSeconds: z.number().describe("Time bucket size in seconds"),
  }),
  outputSchema: z.array(
    z.object({
      apdexScore: z.number(),
      totalCount: z.number(),
    }),
  ),
  execute: async (input) => {
    return fetchServiceApdex(
      input.orgId,
      input.serviceName,
      input.startTime,
      input.endTime,
      input.bucketSeconds,
    )
  },
})

export const fetchErrorTracesTool = createTool({
  id: "fetch-error-traces",
  description: "Fetch sample traces for a specific error type with trace metadata",
  inputSchema: z.object({
    orgId: z.string().describe("Organization ID"),
    errorType: z.string().describe("Error type to find traces for"),
    startTime: z.string().describe("Start time in 'YYYY-MM-DD HH:mm:ss' format"),
    endTime: z.string().describe("End time in 'YYYY-MM-DD HH:mm:ss' format"),
    limit: z.number().optional().describe("Max number of traces to return (default 5)"),
  }),
  outputSchema: z.array(
    z.object({
      traceId: z.string(),
      rootSpanName: z.string(),
      durationMs: z.number(),
      serviceName: z.string(),
      statusCode: z.string(),
    }),
  ),
  execute: async (input) => {
    return fetchErrorTraces(
      input.orgId,
      input.errorType,
      input.startTime,
      input.endTime,
      input.limit,
    )
  },
})

export const fetchSpanHierarchyTool = createTool({
  id: "fetch-span-hierarchy",
  description: "Fetch the full span tree for a trace to understand the request flow",
  inputSchema: z.object({
    orgId: z.string().describe("Organization ID"),
    traceId: z.string().describe("Trace ID to inspect"),
  }),
  outputSchema: z.array(
    z.object({
      traceId: z.string(),
      spanId: z.string(),
      parentSpanId: z.string(),
      spanName: z.string(),
      serviceName: z.string(),
      durationMs: z.number(),
      statusCode: z.string(),
    }),
  ),
  execute: async (input) => {
    return fetchSpanHierarchy(input.orgId, input.traceId)
  },
})

export const searchLogsTool = createTool({
  id: "search-logs",
  description: "Search logs with optional filters for trace ID, service name, and time range",
  inputSchema: z.object({
    orgId: z.string().describe("Organization ID"),
    traceId: z.string().optional().describe("Filter by trace ID"),
    serviceName: z.string().optional().describe("Filter by service name"),
    startTime: z.string().optional().describe("Start time in 'YYYY-MM-DD HH:mm:ss' format"),
    endTime: z.string().optional().describe("End time in 'YYYY-MM-DD HH:mm:ss' format"),
    limit: z.number().optional().describe("Max number of logs to return (default 50)"),
  }),
  outputSchema: z.array(
    z.object({
      timestamp: z.string(),
      severity: z.string(),
      body: z.string(),
      serviceName: z.string(),
      traceId: z.string(),
      spanId: z.string(),
    }),
  ),
  execute: async (input) => {
    return searchLogs(input.orgId, {
      traceId: input.traceId,
      serviceName: input.serviceName,
      startTime: input.startTime,
      endTime: input.endTime,
      limit: input.limit,
    })
  },
})

export const tinybirdTools = {
  fetchErrorsSummaryTool,
  fetchErrorsByTypeTool,
  fetchServiceOverviewTool,
  fetchServiceApdexTool,
  fetchErrorTracesTool,
  fetchSpanHierarchyTool,
  searchLogsTool,
}
