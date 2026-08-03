import { consentAllowedSince, hasConsent, readSessionSink, recordTraceId } from "@maple/browser-session"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { registerInstrumentations } from "@opentelemetry/instrumentation"
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch"
import { resourceFromAttributes } from "@opentelemetry/resources"
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web"
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions"
import type { ResolvedConfig } from "./config"

/**
 * Captures every span's trace id into the session sink. Lightweight — runs
 * alongside the BatchSpanProcessor, does no export of its own.
 */
export class TraceIdCollector implements SpanProcessor {
	constructor(private readonly getUserId: () => string | undefined = () => undefined) {}

	onStart(span: Span): void {
		if (!hasConsent()) return
		recordTraceId(span.spanContext().traceId)
		const sessionId = readSessionSink()?.sessionId
		if (sessionId !== undefined) span.setAttribute("session.id", sessionId)
		const userId = this.getUserId()
		if (userId !== undefined) span.setAttribute("user.id", userId)
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
 * Drops buffered spans captured while consent was absent. Checking start time,
 * rather than only permission at flush time, also prevents a late grant from
 * releasing spans that began before that grant.
 */
class ConsentSpanExporter implements SpanExporter {
	constructor(private readonly inner: SpanExporter) {}

	export(spans: ReadableSpan[], callback: (result: { code: number; error?: Error }) => void): void {
		const since = consentAllowedSince()
		if (!hasConsent() || !Number.isFinite(since)) {
			callback({ code: 0 })
			return
		}
		const eligible = spans.filter(
			(span) => span.startTime[0] * 1_000 + span.startTime[1] / 1_000_000 >= since,
		)
		if (eligible.length === 0) {
			callback({ code: 0 })
			return
		}
		this.inner.export(eligible, callback)
	}

	forceFlush(): Promise<void> {
		return this.inner.forceFlush?.() ?? Promise.resolve()
	}

	shutdown(): Promise<void> {
		return this.inner.shutdown()
	}
}

/**
 * Set up browser OTel tracing exporting to Maple's ingest. When
 * `tracingInstrumentFetch` is true, fetch() calls are auto-instrumented and
 * their trace ids feed the session. Disable it when an external tracer (e.g.
 * the Effect client SDK) already instruments requests — that tracer feeds the
 * session via the published sink instead, and this avoids redundant duplicate
 * network spans. Returns a shutdown function.
 *
 * `session.id` is deliberately **not** a resource attribute: the resource is
 * fixed for the provider's lifetime, but sessions rotate under it (idle
 * rotation, consent revoke→re-grant), so a resource-level id would attribute
 * every post-rotation span to the ended session. `TraceIdCollector` stamps the
 * live id per span instead.
 */
export function setupTracing(config: ResolvedConfig): () => Promise<void> {
	const attributes: Record<string, string> = {
		[ATTR_SERVICE_NAME]: config.serviceName,
		"maple.sdk.type": "browser",
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

	const exporter = new ConsentSpanExporter(
		new OTLPTraceExporter({
			url: `${config.endpoint}/v1/traces`,
			headers: { Authorization: `Bearer ${config.ingestKey}` },
		}),
	)

	const provider = new WebTracerProvider({
		resource: resourceFromAttributes(attributes),
		// The id only — the rest of the identity (email, group) belongs on the
		// session row, not stamped onto every span on the hot path.
		spanProcessors: [new TraceIdCollector(() => config.identity?.id), new BatchSpanProcessor(exporter)],
	})
	provider.register()

	const unregisterInstrumentations = config.tracingInstrumentFetch
		? registerInstrumentations({
				instrumentations: [
					new FetchInstrumentation({
						// Propagate trace context to same-origin + Maple ingest only by
						// default; customers widen via their own config if needed.
						ignoreUrls: [new RegExp(`${escapeRegExp(config.endpoint)}/v1/`)],
					}),
				],
			})
		: undefined

	return async () => {
		unregisterInstrumentations?.()
		await provider.shutdown()
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
