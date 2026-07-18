---
title: "CLI Reference"
description: "Every maple command, argument, and flag — plus the server endpoints, environment variables, and troubleshooting for local mode."
group: "Local Mode"
order: 2
---

The `maple` binary is one CLI with two backends: a local server (`maple start`) and a remote workspace (`maple login`). Every query command runs against whichever is [resolved](#auth-and-configuration) for that invocation. Output is JSON by default — clean enough to pipe into `jq` or an agent.

This page is the complete surface. For a guided walkthrough, start with [Maple Local](/docs/local-mode).

## Global flags

These are accepted by every command (position-independent — `maple --local traces` and `maple traces --local` both work):

| Flag                     | Description                                                                       |
| ------------------------ | --------------------------------------------------------------------------------- |
| `--local`                | Force local mode (requires a running `maple start`)                               |
| `--remote`               | Force remote mode (requires `maple login`)                                        |
| `--debug`                | Print the compiled SQL and per-query timing to stderr (stdout stays clean JSON)   |
| `--format <json\|table>` | Output format; default `json`. `table` renders a flat row set as an aligned table |

Most **query** commands also share a set of filter flags. Defaults and availability vary per command (listed below), but the shapes are consistent:

| Flag               | Alias | Default | Description                                                  |
| ------------------ | ----- | ------- | ------------------------------------------------------------ |
| `--since <range>`  |       | `6h`    | Relative time range — `30m`, `1h`, `6h`, `24h`, `7d`         |
| `--start <time>`   |       |         | Absolute start, `YYYY-MM-DD HH:mm:ss` UTC (use with `--end`) |
| `--end <time>`     |       |         | Absolute end, `YYYY-MM-DD HH:mm:ss` UTC                      |
| `--service <name>` | `-s`  |         | Filter by service name                                       |
| `--env <name>`     | `-e`  |         | Filter by deployment environment (e.g. `production`)         |
| `--limit <n>`      | `-n`  | `20`    | Maximum number of results                                    |
| `--offset <n>`     |       | `0`     | Pagination offset                                            |

## Server commands

Local mode only. `maple start` is the long-lived process that owns the embedded chDB connection; the query commands talk to it over HTTP.

### `maple start`

Start the local ingest + query server (embedded ClickHouse via chDB).

| Flag                                                | Default                      | Description                                                         |
| --------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------- |
| `--host <address>`                                  | `127.0.0.1`                  | Bind address; non-loopback exposes all unauthenticated local routes |
| `--advertise-host <host>`                           | connection-safe bind address | Host printed for clients and the bundled UI                         |
| `--port <int>`                                      | `4318`                       | Port for OTLP/HTTP ingest, query API, and bundled UI                |
| `--data-dir <path>`                                 | `~/.maple/data`              | Embedded ClickHouse data directory                                  |
| `--chdb-config-file <path>`                         |                              | Optional ClickHouse config file passed to embedded chDB             |
| `--offline`                                         | `false`                      | Serve the bundled same-origin UI instead of `local.maple.dev`       |
| `--background`, `-d`                                | `false`                      | Run detached; stop with `maple stop`                                |
| `--reset`                                           | `false`                      | Wipe live chDB data while preserving checkpoints                    |
| `--on-dirty-store <wipe\|fail\|restore-checkpoint>` | `fail`                       | Recovery policy when the store was not cleanly closed               |

```bash
maple start                    # foreground, UI from local.maple.dev
maple start --offline          # foreground, bundled UI, no internet needed
maple start -d --port 4400     # detached on a custom port
maple start --host 0.0.0.0 --advertise-host maple.home.arpa --offline
```

Detached startup forwards the selected `--on-dirty-store` policy unchanged to
the foreground child. Before any reset, compatibility check, dirty-store
decision, or data-directory creation, startup reconciles a recorded reset or
checkpoint-restore transaction. Ambiguous, malformed, or conflicting
transaction state fails closed and prints the preserved paths.

The default dirty-store policy is `fail`, so an unclean shutdown never silently
deletes telemetry. Choose `restore-checkpoint` to recover the selected
checkpoint, or explicitly choose `wipe` to discard only live chDB data.
Checkpoint snapshots, pins, operation evidence, and quarantine state under
`<data-dir>/backups` are preserved by both `--reset` and explicit wipe.
Schema-incompatible stores also fail closed until an operator explicitly
resets live data.

### `maple stop`

Stop a running `maple start` server (reads the PID file beside the data dir).

| Flag                | Default         | Description                          |
| ------------------- | --------------- | ------------------------------------ |
| `--data-dir <path>` | `~/.maple/data` | Data directory of the server to stop |

### `maple reset`

Delete live chDB data so the next `maple start` bootstraps fresh. The checkpoint
registry under `<data-dir>/backups` is preserved. Refuses to run while a server
still owns the store.

Reset is journaled beside the data directory and removes only the chDB-owned
top-level directories produced by the bundled native build (`data`, `metadata`,
`store`, and `tmp`). If any other entry exists, reset preserves everything and
fails with the unrecognized paths so an operator can inspect them. Startup
finishes an interrupted recorded reset before it evaluates store compatibility
or cleanliness.

| Flag                | Default         | Description                  |
| ------------------- | --------------- | ---------------------------- |
| `--data-dir <path>` | `~/.maple/data` | Store whose live data clears |
| `--yes`, `-y`       | `false`         | Skip the confirmation prompt |

### `maple checkpoint`

Create and validate a restorable checkpoint of the local chDB store. The running
server must have been started with a chDB config that allows ClickHouse backups:

```xml
<clickhouse>
  <backups>
    <allowed_disk>default</allowed_disk>
    <allowed_path>backups</allowed_path>
  </backups>
</clickhouse>
```

```bash
maple start --chdb-config-file ./chdb-backups.xml
maple checkpoint
```

Checkpoint accepts `--host`, `--port`, and `--data-dir`. Wildcard hosts are
queried through matching loopback; if the server was started with one-off host
or port flags, pass the same values to `maple checkpoint`.

Every completed checkpoint receives an immutable UUID and is written under:

```text
<data-dir>/backups/
  state.json
  snapshots/<checkpoint-id>/
    backup/
    manifest.json
  operations/
  pins/
  quarantine/
  retiring/
```

`state.json` is the only authority for the selected `current` and `previous`
IDs. Maple writes and syncs a strict versioned manifest only after restoring
the native backup into one sacrificial chDB and validating all six raw telemetry
tables. It then selects the snapshot with a synced atomic state-file
replacement. A third checkpoint retires the old previous snapshot only when it
is complete, compatible, unreferenced, and unpinned; uncertain state is
preserved.

The earlier unreleased `backups/{building,current,previous}` preview layout is
not inferred or deleted. If it is present without a valid new state pointer,
checkpoint commands fail closed and report the paths for operator inspection.
Missing, malformed, incompatible, incomplete, or symlinked checkpoint state is
also rejected rather than guessed.

### `maple restore`

Restore the local chDB store from the last promoted checkpoint. Refuses to run
while a server still owns the store. The existing store is moved aside for
quarantine rather than deleted.

| Flag                     | Default          | Description                         |
| ------------------------ | ---------------- | ----------------------------------- |
| `--data-dir <path>`      | `~/.maple/data`  | Store to restore                    |
| `--checkpoint-id <uuid>` | selected current | Restore one immutable checkpoint ID |
| `--yes`, `-y`            | `false`          | Skip the confirmation prompt        |

Restore uses a collision-resistant working path and quarantine, and records a
durable sibling transaction before changing the live directory. Reconciliation
can resume the recorded quarantine, live swap, and marker-update boundaries
idempotently. The displaced live store is never deleted. Unrecorded or
mismatched restore-like paths fail closed without mutation.

```bash
maple restore --yes
maple restore --checkpoint-id 01234567-89ab-4cde-8fab-0123456789ab --yes
```

Checkpoint and restore operations share one maintenance lock. A live owner is
reported as busy; uncertain ownership is preserved and blocks destructive
maintenance.

## Archive commands

Local mode only. Export sealed UTC-day ranges of the six raw telemetry tables
from immutable checkpoints into portable Parquet, queryable independently with
DuckDB. See [Local telemetry archives](/docs/local-telemetry-archives) for the
full architecture, calibration, and off-happy-path reference.

### `maple archive create <range-date> <signal>`

Seal one UTC day of one signal into a validated Parquet generation from a
checkpoint. Resolves and pins the checkpoint (default: current), restores it to
sacrificial scratch, exports bounded Parquet shards, validates row counts and
checksums, atomically selects the generation, and releases the pin. The live
store is never opened for export.

| Argument / Flag   | Description                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `<range-date>`    | UTC day to seal, `YYYY-MM-DD`                                                                             |
| `<signal>`        | `logs`, `traces`, `metrics_sum`, `metrics_gauge`, `metrics_histogram`, or `metrics_exponential_histogram` |
| `--data-dir`      | Live chDB data directory (default: `~/.maple/data`)                                                       |
| `--archive-dir`   | Archive root (default: `~/.maple/archive`)                                                                |
| `--scratch-root`  | Restored-checkpoint scratch root (default: `~/.maple/scratch`)                                            |
| `--checkpoint-id` | Archive from a specific checkpoint instead of the selected current                                        |

A late-arrival re-export creates a new generation that supersedes the old one;
the previous generation is retained but excluded from active listings and query
paths.

### `maple archive list`

Report active archive generations. Superseded generations are retained on disk
but never listed.

| Flag                            | Description                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `--archive-dir`                 | Archive root (default: `~/.maple/archive`)                                                 |
| `--output summary\|paths\|json` | `summary` (default), `paths` (machine-readable active Parquet paths for DuckDB), or `json` |
| `--signal <name>`               | Required with `--output paths`; the signal whose active paths to emit                      |

### `maple archive rebuild <signal>`

Rebuild a signal's `catalog.jsonl` from the authoritative generation manifests,
recovering from a truncated or missing catalog without rescanning Parquet bytes.

## Services

### `maple services`

List active services with throughput, error rate, and P95 latency. Flags: `--since` / `--start` / `--end`, `--env`.

### `maple diagnose <service-name>`

Deep-dive a service: health, top errors, recent traces and logs.

- **`<service-name>`** — service to diagnose
- Flags: `--since` / `--start` / `--end`, `--env`

### `maple service-map`

Service dependency edges (call counts, errors, latency). Flags: `--since` / `--start` / `--end`, `--service`, `--env`.

### `maple top-ops <service-name>`

Top operations (span names) for a service, ranked by a metric.

- **`<service-name>`** — service to inspect
- `--metric <count|avg_duration|p50_duration|p95_duration|p99_duration|error_rate|apdex>` — ranking metric (default `count`)
- Flags: `--since` / `--start` / `--end`, `--limit`

## Traces

### `maple traces`

Search traces/spans.

| Flag                      | Description                                       |
| ------------------------- | ------------------------------------------------- |
| `--span-name <substr>`    | Filter by span name (substring, case-insensitive) |
| `--errors`                | Only include traces with errors                   |
| `--min-duration-ms <int>` | Minimum duration in milliseconds                  |
| `--max-duration-ms <int>` | Maximum duration in milliseconds                  |
| `--http-method <method>`  | Filter by HTTP method (`GET`, `POST`, …)          |

Plus `--since` / `--start` / `--end`, `--service`, `--limit`, `--offset`.

```bash
maple traces --service api --min-duration-ms 500 --errors --since 1h
```

### `maple trace <trace-id>`

Inspect a trace: full span tree + correlated logs.

- **`<trace-id>`** — trace ID to inspect

### `maple slow-traces`

Find the slowest traces with duration stats. Flags: `--since` / `--start` / `--end`, `--service`, `--env`, `--limit`.

## Errors

### `maple errors`

List error groups by fingerprint (count, affected services, last seen). Flags: `--since` / `--start` / `--end`, `--service`, `--env`, `--limit`.

### `maple error <fingerprint-hash>`

Show detail for one error group: sample traces + timeseries.

- **`<fingerprint-hash>`** — error fingerprint hash (from the `errors` command)
- Flags: `--since` / `--start` / `--end`, `--service`, `--limit`

## Logs

### `maple logs`

Search logs with filtering.

| Flag                 | Alias | Description                                                        |
| -------------------- | ----- | ------------------------------------------------------------------ |
| `--severity <level>` |       | Filter by severity (`TRACE`/`DEBUG`/`INFO`/`WARN`/`ERROR`/`FATAL`) |
| `--search <text>`    | `-q`  | Search text (substring match)                                      |
| `--trace-id <id>`    |       | Filter by trace ID                                                 |

Plus `--since` / `--start` / `--end`, `--service`, `--limit`, `--offset`.

### `maple log-patterns`

Cluster logs into templates to surface the noisiest patterns. Flags: `--since` / `--start` / `--end`, `--service`, `--severity`, `--search`/`-q`, `--limit`.

## Attributes

`maple attributes` has two subcommands for discovering attribute keys and values.

### `maple attributes keys`

Discover available attribute keys.

| Flag                                   | Default  | Description                   |
| -------------------------------------- | -------- | ----------------------------- |
| `--source <traces\|metrics\|services>` | `traces` | Attribute source              |
| `--scope <span\|resource>`             | `span`   | Attribute scope (traces only) |

Plus `--service`, `--since` / `--start` / `--end`, `--limit`.

### `maple attributes values <key>`

List values for an attribute key.

- **`<key>`** — attribute key to list values for
- Flags: same as `attributes keys`

## Metrics and raw SQL

### `maple metrics`

List available metrics. Flags: `--since` / `--start` / `--end`, `--service`, `--search`/`-q`, `--limit`.

### `maple query "<sql>"`

Run raw ClickHouse SQL against the local chDB store — an escape hatch for anything the typed commands don't cover.

- **`<sql>`** — raw ClickHouse SQL

```bash
maple query "SELECT ServiceName, count() FROM traces GROUP BY ServiceName ORDER BY 2 DESC"
```

> **Local only.** Raw SQL against the multi-tenant cloud warehouse would let a client read other orgs' data, so `maple query` returns a clear error in remote mode. Every other command works in both modes.

## Analytics

### `maple timeseries`

Time-bucketed trace metrics (count, latency quantiles, error rate, apdex emitted per bucket).

| Flag                                                              | Default | Description                |
| ----------------------------------------------------------------- | ------- | -------------------------- |
| `--group-by <none\|service\|span_name\|status_code\|http_method>` | `none`  | Group series by dimension  |
| `--span-name <substr>`                                            |         | Filter by span name        |
| `--errors`                                                        | `false` | Only include errored spans |
| `--bucket <seconds>`                                              | `60`    | Bucket size in seconds     |

Plus `--since` / `--start` / `--end`, `--service`, `--env`.

### `maple breakdown`

Top-N trace breakdown by dimension (service, span, status code, http method).

| Flag                                                        | Default     | Description                |
| ----------------------------------------------------------- | ----------- | -------------------------- |
| `--group-by <service\|span_name\|status_code\|http_method>` | `span_name` | Group results by dimension |
| `--span-name <substr>`                                      |             | Filter by span name        |
| `--errors`                                                  | `false`     | Only include errored spans |

Plus `--since` / `--start` / `--end`, `--service`, `--env`, `--limit`.

### `maple compare`

Compare service health between two time windows (regression detection). Provide **either** `--around` **or** all four explicit window bounds.

| Flag                                            | Description                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| `--around <ts>`                                 | Compare the 30m before vs. after this UTC time (`YYYY-MM-DD HH:mm:ss`) |
| `--current-start <ts>` / `--current-end <ts>`   | The "current" window                                                   |
| `--previous-start <ts>` / `--previous-end <ts>` | The baseline window                                                    |
| `--env <name>`                                  | Filter by deployment environment                                       |

## Auth and configuration

Remote credentials live in `~/.maple/config.json` (mode `0600`).

### `maple login`

Save remote workspace credentials.

| Flag              | Description                                                                  |
| ----------------- | ---------------------------------------------------------------------------- |
| `--api-url <url>` | Maple API base URL (e.g. `https://api.maple.dev`)                            |
| `--token <token>` | API token. If omitted, it's read from stdin so it stays out of shell history |

### `maple logout`

Remove the stored remote token from `~/.maple/config.json`.

### `maple whoami`

Show the resolved mode (local/remote) and target.

### `maple use <local|remote|auto>`

Pin the default backend so commands stop auto-detecting, or restore auto-detect.

- **`<mode>`** — `local`, `remote`, or `auto` (clear the pin)

**Mode resolution**, per command, in priority order:

1. `--local` / `--remote` flags.
2. `defaultMode` pinned via `maple use`.
3. Auto-detect — a configured token implies remote; otherwise a quick `GET /health` probe of the local server implies local. If neither is available, the CLI prints an actionable error.

## Server endpoints

`maple start` binds `127.0.0.1` by default. `--host` or
`MAPLE_LOCAL_BIND_HOST` may select another address; doing so exposes every route
below without application authentication. When `--offline` is set, the bundled
SPA is also served over `GET`.

| Method    | Path           | Purpose                                                                 |
| --------- | -------------- | ----------------------------------------------------------------------- |
| `GET`     | `/health`      | Liveness probe (returns `OK`); used by mode auto-detect                 |
| `POST`    | `/v1/traces`   | OTLP traces ingest → `{ "accepted": <rowCount> }`                       |
| `POST`    | `/v1/logs`     | OTLP logs ingest                                                        |
| `POST`    | `/v1/metrics`  | OTLP metrics ingest                                                     |
| `POST`    | `/local/query` | Run SQL: `{ "sql": "..." }` → bare JSON array of rows                   |
| `OPTIONS` | `*`            | Restricted CORS/PNA preflight for the exact configured hosted UI origin |

OTLP bodies may be protobuf (default) or JSON, optionally gzip-encoded. The `/local/query` handler owns the output format — it strips any trailing `FORMAT <ident>` and re-appends `FORMAT JSONEachRow`, then wraps the rows into a JSON array, so clients POST their compiled SQL verbatim.

## Environment variables

**Runtime** (CLI + server):

| Variable                     | Default                    | Purpose                                                                                                                                                |
| ---------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MAPLE_LOCAL_BIND_HOST`      | `127.0.0.1`                | Server bind host and default same-machine CLI target; wildcards map to loopback                                                                        |
| `MAPLE_LOCAL_ADVERTISE_HOST` | connection-safe bind host  | Host printed for clients and the bundled UI                                                                                                            |
| `MAPLE_LOCAL_URL`            | derived bind host + `4318` | Explicit base URL override for CLI query and mode detection                                                                                            |
| `MAPLE_LOCAL_UI_URL`         | `https://local.maple.dev`  | Exact separately hosted UI origin linked by `maple start` and allowed by CORS                                                                          |
| `MAPLE_LIBCHDB`              | _(auto)_                   | Explicit path to `libchdb`. Otherwise resolved beside the binary (Homebrew keeps it in the same `libexec` dir), then `~/.maple/bin/libchdb.{so,dylib}` |
| `MAPLE_API_URL`              | `https://api.maple.dev`    | Remote API base URL                                                                                                                                    |
| `MAPLE_API_TOKEN`            |                            | Remote bearer token (overrides the stored value)                                                                                                       |
| `MAPLE_ORG_ID`               |                            | Remote org override                                                                                                                                    |
| `MAPLE_DEBUG`                |                            | Set to `1` to enable `--debug`                                                                                                                         |
| `MAPLE_FORMAT`               | `json`                     | `json` or `table` — same as `--format`                                                                                                                 |
| `MAPLE_NO_UPDATE_CHECK`      |                            | Set to `1` to disable startup update checks (the Homebrew wrapper sets this automatically)                                                             |

**Homebrew**:

```bash
brew install Makisuo/tap/maple
brew upgrade maple
brew uninstall maple
```

Homebrew-managed installs block `maple update`; use `brew upgrade maple` so Homebrew owns the installed version and receipt.
If Homebrew asks you to trust the third-party tap, run `brew trust Makisuo/tap` once and retry the install.

**Manual installer** (`scripts/install.sh`, env-only):

| Variable              | Default        | Purpose                                                           |
| --------------------- | -------------- | ----------------------------------------------------------------- |
| `MAPLE_VERSION`       | `latest`       | Release tag to install                                            |
| `MAPLE_INSTALL_DIR`   | `~/.maple/bin` | Where the 2-file bundle is installed                              |
| `MAPLE_BIN_DIR`       | _(auto)_       | Where `maple` is symlinked onto `PATH`                            |
| `MAPLE_SKIP_CHECKSUM` | `0`            | Set to `1` to skip SHA-256 verification (air-gapped mirrors only) |

The on-disk config at `~/.maple/config.json` stores `apiUrl`, `token`, `orgId`, and `defaultMode`. Env vars take precedence over stored values.

## Troubleshooting

**`libchdb` not found.** The binary `dlopen`s `libchdb` relative to its own path, then falls back to `~/.maple/bin`. Homebrew keeps `maple` and `libchdb` together in its Cellar; the manual installer keeps them in `~/.maple/bin`. If you move files by hand, keep `libchdb.so`/`.dylib` beside `maple`, or set `MAPLE_LIBCHDB` to its full path. (Running from source has no sibling library — set `MAPLE_LIBCHDB` or drop one in `~/.maple/bin`.)

**Homebrew installed but `maple` still runs the old binary.** You probably have a manual-installer symlink earlier on `PATH`. Run `command -v maple` to confirm, then remove the old symlink or run `curl -fsSL https://maple.dev/cli/uninstall | sh` before reinstalling with Homebrew.

**`maple is already running (PID …)`.** A server already owns this data dir. Stop it with `maple stop`, or start a second instance on another port and data dir: `maple start --port 4400 --data-dir ~/.maple/data-2`.

**Incompatible store after an upgrade.** If a new binary refuses to open an older store (`the local store … is incompatible`), explicitly clear live data with `maple reset --yes`, or start fresh in one step with `maple start --reset`. Both preserve the checkpoint registry; incompatible checkpoints remain preserved and fail closed until deliberately handled.

**Browser asks to "access devices on your local network" (or CORS errors).** The default dashboard at `local.maple.dev` is a public origin reaching your loopback server, which trips Chrome's Private Network Access gate. Run `maple start --offline` to serve the dashboard same-origin — no prompt, no internet needed. For a wildcard LAN bind, also set `--advertise-host` to the hostname the browser will use; other browser hosts and cross-origins are rejected.

**Authentication proxy blocks the bundled UI.** The UI works with TLS and browser-managed authentication such as a session cookie or HTTP authentication. It does not inject a Bearer API key or copy an entry-page query parameter into `/local/query` and OTLP URLs.

**No data appearing.** Confirm your exporter points at the advertised host and port and the server is up (`maple whoami`, or `curl <host>:4318/health`). Widen the time range (`--since 24h` — the default is `6h`). Local mode stores everything under `org_id = "local"`; a successful ingest responds `{ "accepted": <n> }`.

**`No Maple backend found`.** No mode could be resolved: start local mode (`maple start`) or connect a workspace (`maple login`), or force one with `--local` / `--remote`.
