import {
  PulseIcon,
  FileIcon,
  AlertWarningIcon,
  XmarkIcon,
  GridIcon,
  type IconComponent,
} from "@/components/icons"
import type {
  VisualizationType,
  WidgetDataSource,
  WidgetDisplayConfig,
} from "@/components/dashboard-builder/types"

export interface WidgetPresetDefinition {
  id: string
  name: string
  description: string
  visualization: VisualizationType
  dataSource: WidgetDataSource
  display: WidgetDisplayConfig
  icon?: IconComponent
}

export const statPresets: WidgetPresetDefinition[] = [
  {
    id: "stat-total-traces",
    name: "Total Traces",
    description: "Sum of traces across all services",
    icon: PulseIcon,
    visualization: "stat",
    dataSource: {
      endpoint: "service_usage",
      transform: {
        reduceToValue: { field: "totalTraces", aggregate: "sum" },
      },
    },
    display: {
      title: "Total Traces",
      unit: "number",
    },
  },
  {
    id: "stat-total-logs",
    name: "Total Logs",
    description: "Sum of logs across all services",
    icon: FileIcon,
    visualization: "stat",
    dataSource: {
      endpoint: "service_usage",
      transform: {
        reduceToValue: { field: "totalLogs", aggregate: "sum" },
      },
    },
    display: {
      title: "Total Logs",
      unit: "number",
    },
  },
  {
    id: "stat-error-rate",
    name: "Error Rate",
    description: "Overall error rate as percentage",
    icon: AlertWarningIcon,
    visualization: "stat",
    dataSource: {
      endpoint: "errors_summary",
      transform: {
        reduceToValue: { field: "errorRate", aggregate: "first" },
      },
    },
    display: {
      title: "Error Rate",
      unit: "percent",
    },
  },
  {
    id: "stat-total-errors",
    name: "Total Errors",
    description: "Total number of errors",
    icon: XmarkIcon,
    visualization: "stat",
    dataSource: {
      endpoint: "errors_summary",
      transform: {
        reduceToValue: { field: "totalErrors", aggregate: "first" },
      },
    },
    display: {
      title: "Total Errors",
      unit: "number",
    },
  },
  {
    id: "stat-root-error-rate",
    name: "Root Error Rate",
    description: "Error rate for root spans only",
    icon: AlertWarningIcon,
    visualization: "stat",
    dataSource: {
      endpoint: "errors_summary",
      params: { rootOnly: true },
      transform: {
        reduceToValue: { field: "errorRate", aggregate: "first" },
      },
    },
    display: {
      title: "Root Error Rate",
      unit: "percent",
    },
  },
  {
    id: "stat-root-total-errors",
    name: "Root Errors",
    description: "Total number of errors on root spans",
    icon: XmarkIcon,
    visualization: "stat",
    dataSource: {
      endpoint: "errors_summary",
      params: { rootOnly: true },
      transform: {
        reduceToValue: { field: "totalErrors", aggregate: "first" },
      },
    },
    display: {
      title: "Root Errors",
      unit: "number",
    },
  },
  {
    id: "stat-total-services",
    name: "Active Services",
    description: "Number of active services",
    icon: GridIcon,
    visualization: "stat",
    dataSource: {
      endpoint: "service_usage",
      transform: {
        reduceToValue: { field: "serviceName", aggregate: "count" },
      },
    },
    display: {
      title: "Active Services",
      unit: "number",
    },
  },
]

export const listPresets: WidgetPresetDefinition[] = [
  {
    id: "list-traces",
    name: "Recent Traces",
    description: "Latest traces with service, duration, and status",
    visualization: "list",
    dataSource: {
      endpoint: "custom_query_builder_list",
      params: {
        queries: [{
          id: "preset-list-traces",
          name: "A",
          enabled: true,
          dataSource: "traces",
          signalSource: "default",
          metricName: "",
          metricType: "sum",
          isMonotonic: false,
          whereClause: "root_only = true",
          aggregation: "count",
          stepInterval: "",
          orderByDirection: "desc",
          addOns: { groupBy: false, having: false, orderBy: false, limit: false, legend: false },
          groupBy: [],
          having: "",
          orderBy: "",
          limit: "",
          legend: "",
        }],
        limit: 25,
      },
    },
    display: {
      title: "Recent Traces",
      listDataSource: "traces",
      listWhereClause: "",
      listLimit: 25,
      listRootOnly: true,
      columns: [
        { field: "serviceName", header: "Service" },
        { field: "spanName", header: "Span" },
        { field: "durationMs", header: "Duration", unit: "duration_ms", align: "right" },
        { field: "statusCode", header: "Status" },
      ],
    },
  },
  {
    id: "list-error-traces",
    name: "Error Traces",
    description: "Traces with errors",
    visualization: "list",
    dataSource: {
      endpoint: "custom_query_builder_list",
      params: {
        queries: [{
          id: "preset-list-errors",
          name: "A",
          enabled: true,
          dataSource: "traces",
          signalSource: "default",
          metricName: "",
          metricType: "sum",
          isMonotonic: false,
          whereClause: "root_only = true AND has_error = true",
          aggregation: "count",
          stepInterval: "",
          orderByDirection: "desc",
          addOns: { groupBy: false, having: false, orderBy: false, limit: false, legend: false },
          groupBy: [],
          having: "",
          orderBy: "",
          limit: "",
          legend: "",
        }],
        limit: 25,
      },
    },
    display: {
      title: "Error Traces",
      listDataSource: "traces",
      listWhereClause: "has_error = true",
      listLimit: 25,
      listRootOnly: true,
      columns: [
        { field: "serviceName", header: "Service" },
        { field: "spanName", header: "Span" },
        { field: "durationMs", header: "Duration", unit: "duration_ms", align: "right" },
        { field: "statusCode", header: "Status" },
      ],
    },
  },
  {
    id: "list-logs",
    name: "Recent Logs",
    description: "Latest log entries",
    visualization: "list",
    dataSource: {
      endpoint: "list_logs",
      params: { limit: 25 },
    },
    display: {
      title: "Recent Logs",
      listDataSource: "logs",
      listWhereClause: "",
      listLimit: 25,
      columns: [
        { field: "timestamp", header: "Time" },
        { field: "severityText", header: "Severity" },
        { field: "serviceName", header: "Service" },
        { field: "body", header: "Message" },
      ],
    },
  },
]

export const tablePresets: WidgetPresetDefinition[] = [
  {
    id: "table-traces",
    name: "Recent Traces",
    description: "Latest traces with duration and status",
    visualization: "table",
    dataSource: {
      endpoint: "list_traces",
      params: { limit: 5 },
      transform: { limit: 5 },
    },
    display: {
      title: "Recent Traces",
      columns: [
        { field: "rootSpanName", header: "Root Span" },
        { field: "durationMs", header: "Duration", unit: "duration_ms", align: "right" },
        { field: "hasError", header: "Status", align: "right" },
      ],
    },
  },
  {
    id: "table-errors",
    name: "Errors by Type",
    description: "Error types with counts and affected services",
    visualization: "table",
    dataSource: {
      endpoint: "errors_by_type",
      params: { limit: 5 },
      transform: { limit: 5 },
    },
    display: {
      title: "Errors by Type",
      columns: [
        { field: "errorType", header: "Error Type" },
        { field: "count", header: "Count", unit: "number", align: "right" },
        { field: "affectedServicesCount", header: "Services", align: "right" },
      ],
    },
  },
  {
    id: "table-root-errors",
    name: "Root Errors by Type",
    description: "Error types on root spans only",
    visualization: "table",
    dataSource: {
      endpoint: "errors_by_type",
      params: { limit: 5, rootOnly: true },
      transform: { limit: 5 },
    },
    display: {
      title: "Root Errors by Type",
      columns: [
        { field: "errorType", header: "Error Type" },
        { field: "count", header: "Count", unit: "number", align: "right" },
        { field: "affectedServicesCount", header: "Services", align: "right" },
      ],
    },
  },
  {
    id: "table-services",
    name: "Service Overview",
    description: "Services with latency, errors, and throughput",
    visualization: "table",
    dataSource: {
      endpoint: "service_overview",
    },
    display: {
      title: "Service Overview",
      columns: [
        { field: "serviceName", header: "Service" },
        { field: "p95LatencyMs", header: "P95", unit: "duration_ms", align: "right" },
        { field: "errorRate", header: "Error Rate", unit: "percent", align: "right" },
        { field: "throughput", header: "Throughput", unit: "requests_per_sec", align: "right" },
      ],
    },
  },
]

