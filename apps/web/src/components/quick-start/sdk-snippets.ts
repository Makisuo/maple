export type FrameworkId = "nextjs" | "nodejs" | "python" | "go" | "effect"

export interface SdkSnippet {
  language: FrameworkId
  label: string
  description: string
  iconKey: FrameworkId
  install: string | { packages: string[] }
  instrument: string
}

export const sdkSnippets: SdkSnippet[] = [
  {
    language: "nextjs",
    label: "Next.js",
    description: "React framework",
    iconKey: "nextjs",
    install: { packages: ["@vercel/otel", "@opentelemetry/sdk-logs", "@opentelemetry/exporter-logs-otlp-http"] },
    instrument: `// instrumentation.ts (project root)
import { registerOTel } from "@vercel/otel";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";

export function register() {
  registerOTel({
    serviceName: "my-next-app",
    attributes: { environment: "production" },
    traceExporter: { url: "{{INGEST_URL}}/v1/traces" },
    logRecordProcessor: new SimpleLogRecordProcessor(
      new OTLPLogExporter({
        url: "{{INGEST_URL}}/v1/logs",
        headers: { Authorization: "Bearer {{API_KEY}}" },
      })
    ),
  });
}`,
  },
  {
    language: "nodejs",
    label: "Node.js",
    description: "JavaScript runtime",
    iconKey: "nodejs",
    install: { packages: ["@opentelemetry/sdk-node", "@opentelemetry/auto-instrumentations-node", "@opentelemetry/exporter-trace-otlp-http", "@opentelemetry/exporter-logs-otlp-http"] },
    instrument: `// tracing.js — run with: node --require ./tracing.js app.js
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-http");
const { SimpleLogRecordProcessor } = require("@opentelemetry/sdk-logs");

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: "{{INGEST_URL}}/v1/traces",
    headers: { Authorization: "Bearer {{API_KEY}}" },
  }),
  logRecordProcessors: [
    new SimpleLogRecordProcessor(
      new OTLPLogExporter({
        url: "{{INGEST_URL}}/v1/logs",
        headers: { Authorization: "Bearer {{API_KEY}}" },
      })
    ),
  ],
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();`,
  },
  {
    language: "python",
    label: "Python",
    description: "General purpose",
    iconKey: "python",
    install: `pip install opentelemetry-sdk \\
  opentelemetry-exporter-otlp-proto-http \\
  opentelemetry-instrumentation`,
    instrument: `# tracing.py
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

provider = TracerProvider()
exporter = OTLPSpanExporter(
    endpoint="{{INGEST_URL}}/v1/traces",
    headers={"Authorization": "Bearer {{API_KEY}}"},
)
provider.add_span_processor(BatchSpanProcessor(exporter))
trace.set_tracer_provider(provider)

# Create a tracer and send a test span
tracer = trace.get_tracer("quickstart")
with tracer.start_as_current_span("hello-maple"):
    print("Trace sent!")`,
  },
  {
    language: "go",
    label: "Go",
    description: "Systems language",
    iconKey: "go",
    install: `go get go.opentelemetry.io/otel \\
  go.opentelemetry.io/otel/sdk \\
  go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp`,
    instrument: `package main

import (
	"context"
	"log"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/trace"
)

func main() {
	ctx := context.Background()

	exporter, err := otlptracehttp.New(ctx,
		otlptracehttp.WithEndpointURL("{{INGEST_URL}}/v1/traces"),
		otlptracehttp.WithHeaders(map[string]string{
			"Authorization": "Bearer {{API_KEY}}",
		}),
	)
	if err != nil {
		log.Fatal(err)
	}

	tp := trace.NewTracerProvider(trace.WithBatcher(exporter))
	defer tp.Shutdown(ctx)
	otel.SetTracerProvider(tp)

	// Send a test span
	tracer := otel.Tracer("quickstart")
	_, span := tracer.Start(ctx, "hello-maple")
	span.End()
	tp.ForceFlush(ctx)

	log.Println("Trace sent!")
}`,
  },
  {
    language: "effect",
    label: "Effect",
    description: "TypeScript toolkit",
    iconKey: "effect",
    install: { packages: ["effect", "@effect/opentelemetry", "@effect/platform", "@opentelemetry/sdk-trace-node"] },
    instrument: `// telemetry.ts
import * as Otlp from "@effect/opentelemetry/Otlp"
import * as FetchHttpClient from "@effect/platform/FetchHttpClient"
import { Effect, Layer } from "effect"

export const TracerLive = Otlp.layerJson({
  baseUrl: "{{INGEST_URL}}",
  resource: {
    serviceName: "my-effect-app",
    serviceVersion: "1.0.0",
  },
  headers: {
    "Authorization": "Bearer {{API_KEY}}",
  },
}).pipe(Layer.provide(FetchHttpClient.layer))

// Use in your program
const program = Effect.gen(function* () {
  yield* Effect.log("Hello from Effect!")
}).pipe(Effect.withSpan("hello-maple"))

Effect.runPromise(
  program.pipe(Effect.provide(TracerLive))
)`,
  },
]
