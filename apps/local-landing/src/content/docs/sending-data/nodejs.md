---
title: "Node.js"
description: "Send traces, logs, and metrics from a Node.js app to Maple Local with the OpenTelemetry Node SDK."
group: "Sending Data"
order: 2
---

The quickest path is the OpenTelemetry Node SDK with auto-instrumentations — it captures HTTP servers/clients, popular frameworks, and database drivers without code changes.

## Install

```bash
npm install @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node
```

## Zero-code setup

The SDK reads the standard environment variables, so you can enable it entirely from the shell:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318"
export OTEL_SERVICE_NAME="my-node-service"
node --require @opentelemetry/auto-instrumentations-node/register app.js
```

That's it — with `maple start` running, requests show up in `maple traces` and the dashboard.

## Explicit setup

If you prefer wiring it in code (e.g. to control which instrumentations load), create a `tracing.js` loaded before anything else:

```js
import { NodeSDK } from "@opentelemetry/sdk-node"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"

const sdk = new NodeSDK({
	serviceName: "my-node-service",
	instrumentations: [getNodeAutoInstrumentations()],
})

sdk.start()
```

The default OTLP/HTTP exporters already target `http://localhost:4318`, so no exporter config is needed when Maple Local runs on the default port.

## Verify

```bash
maple services
maple traces --service my-node-service --since 5m
```

## Notes

- **Protocol:** the Node SDK defaults to OTLP/HTTP (`http/protobuf`) — exactly what Maple Local speaks. If you've set `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` globally, override it back to `http/protobuf`.
- **Logs:** pino/winston instrumentations (included in auto-instrumentations) forward log records with trace correlation, so log lines appear alongside their spans in the trace view.
