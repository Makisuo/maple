---
title: "Quickstart"
description: "Start the server, point an OTLP exporter at localhost, and open the dashboard — traces in under a minute."
group: "Getting Started"
order: 2
---

Maple Local is the fastest way to look at OpenTelemetry data — point any OTLP exporter at `localhost`, open the dashboard, and explore traces, logs, and metrics with no account and nothing to deploy. Everything is single-tenant and stays on your machine.

## 1. Start the server

```bash
maple start            # OTLP ingest + embedded ClickHouse + query API on :4318
maple start --offline  # …serve the UI bundled in the binary (no internet, no prompts)
maple start -d         # …or detached; logs to ~/.maple/maple.log, stop with `maple stop`
```

`maple start` is the long-lived process: it owns the embedded ClickHouse (chDB) connection and hosts OTLP/HTTP ingest, the `/local/query` API, and (with `--offline`) the dashboard — all on one loopback port. Data persists in `~/.maple/data` between runs.

Common flags: `--port` (default `4318`), `--data-dir` (default `~/.maple/data`), `--offline`, `--background`/`-d`, and `--reset` to wipe an incompatible store before starting. See the [CLI reference](/docs/reference/cli#server-commands) for the full list.

## 2. Send telemetry

The server speaks OTLP/HTTP on `POST /v1/{traces,logs,metrics}` (protobuf or JSON, gzip optional) — the same protocol every OpenTelemetry SDK already exports. Point your app at it; no auth header is needed:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318"
export OTEL_SERVICE_NAME="my-service"
```

Most exporters default to protobuf and work out of the box. For language-specific setup, see [Sending data](/docs/sending-data/overview).

## 3. Open the dashboard

By default `maple start` points you at the auto-updating dashboard hosted at `local.maple.dev`, which talks back to your binary on loopback (the startup banner prints a link with the bound `?port=`). Because that page is a public origin reaching a local server, Chrome may show a one-time "access devices on your local network" prompt.

Pass `--offline` to serve the dashboard bundled inside the binary from `127.0.0.1` instead: same-origin, no prompt, and it works with no internet. See [Offline mode](/docs/operations/offline-mode). The banner always prints the right URL for the mode you chose.

## 4. Query from the terminal

The same binary is also a query CLI. Every command runs against the running server and prints JSON by default (add `--format table` for an aligned table, or `--debug` to see the compiled SQL on stderr):

```bash
maple services                         # active services at a glance
maple traces --service api --since 1h  # recent spans for one service
maple errors --since 24h               # error groups by fingerprint
maple query "SELECT count() FROM traces"
```

Most query flags are shared: `--since` (e.g. `30m`, `1h`, `24h`, `7d`) or absolute `--start`/`--end`, `--service`/`-s`, `--env`/`-e`, and `--limit`/`-n`. The full surface lives in the [CLI reference](/docs/reference/cli).
