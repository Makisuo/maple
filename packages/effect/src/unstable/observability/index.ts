/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * @since 4.0.0
 */
export * as Otlp from "./Otlp.ts"

/**
 * @since 4.0.0
 */
export * as OtlpExporter from "./OtlpExporter.ts"

/**
 * @since 4.0.0
 */
export * as OtlpLogger from "./OtlpLogger.ts"

/**
 * @since 4.0.0
 */
export * as OtlpMetrics from "./OtlpMetrics.ts"

/**
 * @since 4.0.0
 */
export * as OtlpResource from "./OtlpResource.ts"

/**
 * @since 4.0.0
 */
export * as OtlpSerialization from "./OtlpSerialization.ts"

/**
 * @since 4.0.0
 */
export * as OtlpTracer from "./OtlpTracer.ts"

/**
 * Prometheus metrics exporter for Effect's Metric system.
 *
 * This module provides functionality to export Effect metrics in the Prometheus
 * exposition format, making them scrapeable by Prometheus servers.
 *
 * @example
 * ```ts
 * import { Effect, Metric } from "effect"
 * import * as PrometheusMetrics from "effect/unstable/observability/PrometheusMetrics"
 *
 * const program = Effect.gen(function*() {
 *   // Create and update metrics
 *   const counter = Metric.counter("http_requests_total", {
 *     description: "Total HTTP requests"
 *   })
 *   yield* Metric.update(counter, 42)
 *
 *   // Format metrics for Prometheus
 *   const output = yield* PrometheusMetrics.format()
 *   console.log(output)
 *   // # HELP http_requests_total Total HTTP requests
 *   // # TYPE http_requests_total counter
 *   // http_requests_total 42
 * })
 * ```
 *
 * @since 4.0.0
 */
export * as PrometheusMetrics from "./PrometheusMetrics.ts"
