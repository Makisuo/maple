import {
	context,
	propagation,
	SpanKind,
	SpanStatusCode,
	trace,
} from "@opentelemetry/api"
import { logs, SeverityNumber } from "@opentelemetry/api-logs"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs"
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions"
import * as Crypto from "expo-crypto"

const SERVICE_NAME = "maple-mobile"
const DEFAULT_ENDPOINT = "https://ingest.maple.dev"

let initialized = false

export function setupMobileTelemetry(): void {
	if (initialized) return
	const ingestKey = process.env.EXPO_PUBLIC_MAPLE_INGEST_KEY?.trim()
	if (!ingestKey) return

	const endpoint =
		process.env.EXPO_PUBLIC_MAPLE_ENDPOINT?.replace(/\/$/, "") ?? DEFAULT_ENDPOINT
	const environment = __DEV__ ? "development" : "production"
	const commitSha = process.env.EXPO_PUBLIC_COMMIT_SHA
	const resource = resourceFromAttributes({
		[ATTR_SERVICE_NAME]: SERVICE_NAME,
		"service.namespace": "client",
		"service.version": commitSha?.slice(0, 12) ?? "1.0.0",
		"service.instance.id": Crypto.randomUUID(),
		"deployment.environment": environment,
		"deployment.environment.name": environment,
		"maple.sdk.type": "mobile",
		"vcs.repository.url.full": "https://github.com/Makisuo/maple",
		...(commitSha ? { "deployment.commit_sha": commitSha } : {}),
	})

	const tracerProvider = new BasicTracerProvider({
		resource,
		spanProcessors: [
			new BatchSpanProcessor(
				new OTLPTraceExporter({
					url: `${endpoint}/v1/traces`,
					headers: { Authorization: `Bearer ${ingestKey}` },
				}),
			),
		],
	})
	const loggerProvider = new LoggerProvider({
		resource,
		processors: [
			new BatchLogRecordProcessor(
				new OTLPLogExporter({
					url: `${endpoint}/v1/logs`,
					headers: { Authorization: `Bearer ${ingestKey}` },
				}),
			),
		],
	})

	trace.setGlobalTracerProvider(tracerProvider)
	logs.setGlobalLoggerProvider(loggerProvider)
	propagation.setGlobalPropagator(new W3CTraceContextPropagator())
	initialized = true

	const span = trace.getTracer(SERVICE_NAME).startSpan("mobile.startup")
	span.end()
}

const emitRequestError = (message: string, attributes: Record<string, string | number>) => {
	logs.getLogger(SERVICE_NAME).emit({
		severityNumber: SeverityNumber.ERROR,
		severityText: "ERROR",
		body: "mobile.http_request_failed",
		attributes: { ...attributes, "error.message": message },
	})
}

export async function tracedFetch(
	url: string,
	init: RequestInit,
	peerService: string,
): Promise<Response> {
	const method = init.method ?? "GET"
	return trace.getTracer(SERVICE_NAME).startActiveSpan(
		"http.client",
		{
			kind: SpanKind.CLIENT,
			attributes: {
				"http.request.method": method,
				"url.full": url,
				"server.address": new URL(url).hostname,
				"peer.service": peerService,
			},
		},
		async (span) => {
			const headers = new Headers(init.headers)
			propagation.inject(context.active(), headers, {
				set: (carrier, key, value) => carrier.set(key, value),
			})
			try {
				const response = await fetch(url, { ...init, headers })
				span.setAttribute("http.response.status_code", response.status)
				if (response.status >= 500) {
					span.setStatus({
						code: SpanStatusCode.ERROR,
						message: `HTTP ${response.status}`,
					})
				}
				return response
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				span.setAttribute(
					"error.type",
					error instanceof Error ? error.name : "UnknownError",
				)
				span.setStatus({ code: SpanStatusCode.ERROR, message })
				span.recordException(
					error instanceof Error ? error : { name: "UnknownError", message },
				)
				emitRequestError(message, {
					"http.request.method": method,
					"url.full": url,
					"peer.service": peerService,
				})
				throw error
			} finally {
				span.end()
			}
		},
	)
}
