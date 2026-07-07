import { WebTracerProvider } from "@opentelemetry/sdk-trace-web"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { registerInstrumentations } from "@opentelemetry/instrumentation"
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch"
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions"
import type { ResolvedConfig } from "./config"
import { recordTraceId } from "@maple/browser-session"

/**
 * Captures every span's trace id into the session sink. Lightweight — runs
 * alongside the BatchSpanProcessor, does no export of its own.
 */
class TraceIdCollector implements SpanProcessor {
	onStart(span: Span): void {
		recordTraceId(span.spanContext().traceId)
	}
	onEnd(_span: ReadableSpan): void {}
	forceFlush(): Promise<void> {
		return Promise.resolve()
	}
	shutdown(): Promise<void> {
		return Promise.resolve()
	}
}

/**
 * Set up browser OTel tracing exporting to Maple's ingest, tagging the resource
 * with the shared `session.id`. When `tracingInstrumentFetch` is true, fetch()
 * calls are auto-instrumented and their trace ids feed the session. Disable it
 * when an external tracer (e.g. the Effect client SDK) already instruments
 * requests — that tracer feeds the session via the published sink instead, and
 * this avoids redundant duplicate network spans. Returns a shutdown function.
 */
export function setupTracing(config: ResolvedConfig, sessionId: string): () => Promise<void> {
	const attributes: Record<string, string> = {
		[ATTR_SERVICE_NAME]: config.serviceName,
		"maple.sdk.type": "browser",
		"session.id": sessionId,
	}
	if (config.serviceNamespace) {
		attributes["service.namespace"] = config.serviceNamespace
	}
	if (config.serviceVersion) {
		attributes[ATTR_SERVICE_VERSION] = config.serviceVersion
		attributes["deployment.commit_sha"] = config.serviceVersion
	}
	if (config.environment) {
		// Dual-emit: legacy key (pre-extracted by Tinybird MVs) + the canonical
		// resource attribute. Keep both until the MVs coalesce them.
		attributes["deployment.environment"] = config.environment
		attributes["deployment.environment.name"] = config.environment
	}

	const exporter = new OTLPTraceExporter({
		url: `${config.endpoint}/v1/traces`,
		headers: { Authorization: `Bearer ${config.ingestKey}` },
	})

	const provider = new WebTracerProvider({
		resource: resourceFromAttributes(attributes),
		spanProcessors: [new TraceIdCollector(), new BatchSpanProcessor(exporter)],
	})
	provider.register()

	if (config.tracingInstrumentFetch) {
		registerInstrumentations({
			instrumentations: [
				new FetchInstrumentation({
					// Propagate trace context to same-origin + Maple ingest only by
					// default; customers widen via their own config if needed.
					ignoreUrls: [new RegExp(`${escapeRegExp(config.endpoint)}/v1/`)],
				}),
			],
		})
	}

	return () => provider.shutdown()
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
