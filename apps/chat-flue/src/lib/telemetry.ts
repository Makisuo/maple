import { type Context, context, propagation, trace } from "@opentelemetry/api"
import { logs, SeverityNumber } from "@opentelemetry/api-logs"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs"
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions"

/** Service name stamped on every chat-flue span and used for the tracer. */
export const CHAT_FLUE_SERVICE_NAME = "maple-chat-flue"

/** Default Maple ingest gateway (overridable via MAPLE_ENDPOINT). */
const DEFAULT_ENDPOINT = "https://ingest.maple.dev"

export interface TelemetryConfig {
	/** Maple ingest key. Telemetry is disabled (no-op) when absent. */
	ingestKey?: string
	/** OTLP endpoint base; defaults to {@link DEFAULT_ENDPOINT}. */
	endpoint?: string
	/** Deployment environment label (`development` / `production` / …). */
	environment?: string
	/** Deployed application version. */
	serviceVersion?: string
	/** Source revision deployed to the worker. */
	commitSha?: string
}

export interface ChatFlueTelemetry {
	readonly getTracer: BasicTracerProvider["getTracer"]
	readonly forceFlush: () => Promise<void>
}

let telemetryActive = false

type LogAttributes = Readonly<Record<string, string | number | boolean>>

export function emitTelemetryLog(
	severity: "info" | "warn" | "error",
	body: string,
	attributes: LogAttributes = {},
): void {
	if (!telemetryActive) {
		const fallback =
			severity === "error" ? console.error : severity === "warn" ? console.warn : console.info
		fallback(body, attributes)
		return
	}

	const activeSpan = trace.getActiveSpan()
	const spanContext = activeSpan?.spanContext()
	logs.getLogger(CHAT_FLUE_SERVICE_NAME).emit({
		severityNumber:
			severity === "error"
				? SeverityNumber.ERROR
				: severity === "warn"
					? SeverityNumber.WARN
					: SeverityNumber.INFO,
		severityText: severity.toUpperCase(),
		body,
		attributes: {
			...attributes,
			...(spanContext
				? {
						"trace.id": spanContext.traceId,
						"span.id": spanContext.spanId,
					}
				: {}),
		},
	})
}

/**
 * Set up OpenTelemetry for the Flue chat worker, exporting spans to Maple's
 * ingest gateway. Mirrors `packages/browser/src/tracing.ts` but for the Worker
 * runtime — `BasicTracerProvider` + a fetch-based OTLP/JSON exporter instead of
 * `WebTracerProvider`.
 *
 * Returns the provider when telemetry is active (so the caller can force a flush
 * at Flue run/idle boundaries and on the HTTP response), or `undefined` when no
 * ingest key is configured — keeping local dev silent with zero export noise.
 *
 * `maple_org_id` is intentionally NOT set: the ingest gateway strips any
 * client-supplied org attribution and injects it from the ingest key, so
 * chat-flue's spans land in whichever org the key belongs to (the internal org,
 * alongside `maple-api`).
 *
 * Call this exactly once per isolate, at `app.ts` module scope. The Flue
 * generated entry imports `app.ts` into every isolate it loads — the top-level
 * worker AND the chat-agent / triage-workflow Durable Objects — so this same
 * setup instruments the DO isolates where the model/tool/run events fire.
 */
export function setupTelemetry(config: TelemetryConfig): ChatFlueTelemetry | undefined {
	const ingestKey = config.ingestKey?.trim()
	if (!ingestKey) return undefined

	const endpoint = config.endpoint?.trim() || DEFAULT_ENDPOINT

	const attributes: Record<string, string> = {
		[ATTR_SERVICE_NAME]: CHAT_FLUE_SERVICE_NAME,
		"service.namespace": "backend",
		"service.instance.id": crypto.randomUUID(),
		"service.version": config.serviceVersion?.trim() || "development",
		"maple.sdk.type": "flue",
		"vcs.repository.url.full": "https://github.com/Makisuo/maple",
	}
	if (config.commitSha?.trim()) {
		attributes["deployment.commit_sha"] = config.commitSha.trim()
	}
	if (config.environment) {
		// Dual-emit: Tinybird MVs pre-extract the legacy `deployment.environment`;
		// keep both it and the OTel-canonical `.name` until the MVs coalesce them
		// (matches `packages/browser/src/tracing.ts`).
		attributes["deployment.environment"] = config.environment
		attributes["deployment.environment.name"] = config.environment
	}

	const exporter = new OTLPTraceExporter({
		url: `${endpoint}/v1/traces`,
		headers: { Authorization: `Bearer ${ingestKey}` },
	})

	const provider = new BasicTracerProvider({
		resource: resourceFromAttributes(attributes),
		spanProcessors: [new BatchSpanProcessor(exporter)],
	})
	const logProvider = new LoggerProvider({
		resource: resourceFromAttributes(attributes),
		processors: [
			new BatchLogRecordProcessor(
				new OTLPLogExporter({
					url: `${endpoint}/v1/logs`,
					headers: { Authorization: `Bearer ${ingestKey}` },
				}),
			),
		],
	})

	// The Worker `BasicTracerProvider` has no `.register()` helper, so wire the
	// `@opentelemetry/api` globals explicitly: the tracer provider so any
	// `@opentelemetry/api` consumer resolves to it, and the W3C propagator so
	// `rootContextFromRequest` can extract inbound trace context.
	trace.setGlobalTracerProvider(provider)
	logs.setGlobalLoggerProvider(logProvider)
	propagation.setGlobalPropagator(new W3CTraceContextPropagator())
	telemetryActive = true

	return {
		getTracer: provider.getTracer.bind(provider),
		forceFlush: () =>
			Promise.all([provider.forceFlush(), logProvider.forceFlush()]).then(() => undefined),
	}
}

/**
 * Extract W3C trace context from an inbound request's headers so chat spans nest
 * under the caller's (web/mobile) distributed trace. Returns `undefined` when
 * there's no request; falls back to a standalone trace when the caller sent no
 * `traceparent`. Relies on the global propagator set by {@link setupTelemetry},
 * so only call this once telemetry is active.
 */
export function rootContextFromRequest(req: Request | undefined): Context | undefined {
	if (!req) return undefined
	return propagation.extract(context.active(), Object.fromEntries(req.headers))
}
