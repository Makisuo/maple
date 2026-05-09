import { defineCatalog } from "@json-render/core"
import { schema } from "@json-render/react/schema"
import { z } from "zod"

export const catalog = defineCatalog(schema, {
	components: {
		Stack: {
			props: z.object({ gap: z.number().optional() }),
			description: "Vertical stack layout container",
		},
		TraceList: {
			props: z.object({
				traces: z.array(
					z.object({
						traceId: z.string(),
						rootSpanName: z.string(),
						durationMs: z.number(),
						spanCount: z.number(),
						services: z.array(z.string()),
						hasError: z.boolean(),
						startTime: z.string().optional(),
						errorMessage: z.string().optional(),
					}),
				),
				stats: z
					.object({
						p50Ms: z.number(),
						p95Ms: z.number(),
						minMs: z.number(),
						maxMs: z.number(),
					})
					.optional(),
			}),
			description: "Table of traces with duration, services, and error indicators",
		},
		LogList: {
			props: z.object({
				logs: z.array(
					z.object({
						timestamp: z.string(),
						severityText: z.string(),
						serviceName: z.string(),
						body: z.string(),
						traceId: z.string().optional(),
						spanId: z.string().optional(),
					}),
				),
				totalCount: z.number().optional(),
			}),
			description: "List of log entries with severity, timestamp, and service",
		},
		ServiceTable: {
			props: z.object({
				services: z.array(
					z.object({
						name: z.string(),
						throughput: z.number(),
						errorRate: z.number(),
						p50Ms: z.number(),
						p95Ms: z.number(),
						p99Ms: z.number(),
					}),
				),
				dataVolume: z
					.array(
						z.object({
							name: z.string(),
							traces: z.number(),
							logs: z.number(),
							metrics: z.number(),
						}),
					)
					.optional(),
			}),
			description: "Table of services with throughput, error rate, and latency",
		},
		ErrorList: {
			props: z.object({
				errors: z.array(
					z.object({
						errorType: z.string(),
						count: z.number(),
						affectedServices: z.array(z.string()),
						lastSeen: z.string(),
					}),
				),
			}),
			description: "List of errors grouped by type with count and affected services",
		},
		SpanTree: {
			props: z.object({
				traceId: z.string(),
				spans: z.array(
					z.lazy(() =>
						z.object({
							spanId: z.string(),
							parentSpanId: z.string(),
							spanName: z.string(),
							serviceName: z.string(),
							durationMs: z.number(),
							statusCode: z.string(),
							statusMessage: z.string(),
							children: z.array(z.any()),
						}),
					),
				),
			}),
			description: "Indented span tree showing trace hierarchy",
		},
		SystemHealthCard: {
			props: z.object({
				serviceCount: z.number(),
				totalSpans: z.number(),
				totalErrors: z.number(),
				errorRate: z.number(),
				affectedServicesCount: z.number(),
				latency: z.object({ p50Ms: z.number(), p95Ms: z.number() }),
				topErrors: z.array(
					z.object({
						errorType: z.string(),
						count: z.number(),
						affectedServicesCount: z.number(),
					}),
				),
			}),
			description: "System health overview with stats grid and top errors",
		},
		MetricsList: {
			props: z.object({
				summary: z.array(
					z.object({
						metricType: z.string(),
						metricCount: z.number(),
						dataPointCount: z.number(),
					}),
				),
				metrics: z.array(
					z.object({
						metricName: z.string(),
						metricType: z.string(),
						serviceName: z.string(),
						metricUnit: z.string(),
						dataPointCount: z.number(),
					}),
				),
			}),
			description: "List of metrics with summary counts by type",
		},
		StatCards: {
			props: z.object({
				cards: z.array(
					z.object({
						label: z.string(),
						value: z.union([z.string(), z.number()]),
						format: z.enum(["number", "percent", "duration", "decimal", "text"]),
					}),
				),
			}),
			description: "Horizontal row of stat cards with formatted values",
		},
		DataTable: {
			props: z.object({
				headers: z.array(z.string()),
				rows: z.array(z.array(z.string())),
				title: z.string().optional(),
			}),
			description: "Generic data table with headers and rows",
		},
		QueryChart: {
			props: z.object({
				data: z.array(
					z.object({
						bucket: z.string(),
						series: z.record(z.string(), z.number()),
					}),
				),
				metric: z.string(),
				unit: z.string(),
				source: z.string(),
				groupBy: z.string().optional(),
			}),
			description: "Timeseries area chart for query_data results",
		},
	},
	actions: {},
})
