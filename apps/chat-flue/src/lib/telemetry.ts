import { type Context, context, propagation, trace } from "@opentelemetry/api"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
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
	/** Deployed commit or release identifier. */
	serviceVersion?: string
}

export function telemetryResourceAttributes(
	config: Pick<TelemetryConfig, "environment" | "serviceVersion">,
	instanceId: string,
): Record<string, string> {
	const attributes: Record<string, string> = {
		[ATTR_SERVICE_NAME]: CHAT_FLUE_SERVICE_NAME,
		"service.namespace": "backend",
		"service.instance.id": instanceId,
		"cloud.provider": "cloudflare",
		"cloud.platform": "cloudflare.workers",
		"process.runtime.name": "workerd",
		"maple.sdk.type": "flue",
		"vcs.repository.url.full": "https://github.com/Makisuo/maple",
	}
	const serviceVersion = config.serviceVersion?.trim() || "dev"
	const environment = config.environment?.trim() || "development"
	attributes["service.version"] = serviceVersion
	// Dual-emit: Tinybird MVs pre-extract the legacy `deployment.environment`;
	// keep both it and the OTel-canonical `.name` until the MVs coalesce them.
	attributes["deployment.environment"] = environment
	attributes["deployment.environment.name"] = environment
	return attributes
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
export function setupTelemetry(config: TelemetryConfig): BasicTracerProvider | undefined {
	const ingestKey = config.ingestKey?.trim()
	if (!ingestKey) return undefined

	const endpoint = config.endpoint?.trim() || DEFAULT_ENDPOINT

	const attributes = telemetryResourceAttributes(config, crypto.randomUUID())

	const exporter = new OTLPTraceExporter({
		url: `${endpoint}/v1/traces`,
		headers: { Authorization: `Bearer ${ingestKey}` },
	})

	const provider = new BasicTracerProvider({
		resource: resourceFromAttributes(attributes),
		spanProcessors: [new BatchSpanProcessor(exporter)],
	})

	// The Worker `BasicTracerProvider` has no `.register()` helper, so wire the
	// `@opentelemetry/api` globals explicitly: the tracer provider so any
	// `@opentelemetry/api` consumer resolves to it, and the W3C propagator so
	// `rootContextFromRequest` can extract inbound trace context.
	trace.setGlobalTracerProvider(provider)
	propagation.setGlobalPropagator(new W3CTraceContextPropagator())

	return provider
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
