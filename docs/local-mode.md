# Local mode

Local mode runs Maple as a single self-contained binary: OTLP ingest, an
embedded ClickHouse (chDB) store, a query API, and a UI — no cloud, no Tinybird,
no auth. It's for poking at telemetry on your own machine and for the
distributable "try Maple locally" bundle.

Everything is single-tenant: every row is written under `org_id = "local"`, and
every compiled query filters on it.

## Install

Recommended:

```bash
brew install Makisuo/tap/maple
```

Homebrew downloads the matching release bundle, verifies its checksum, installs
`maple` and `libchdb.so` together in the Homebrew Cellar, and links `maple` onto
your PATH. macOS Apple Silicon and Linux (x86_64 & arm64) are supported. If
Homebrew asks you to trust the third-party tap, run `brew trust Makisuo/tap`
once and retry the install.

Manual installer:

```bash
curl -fsSL https://maple.dev/cli/install | sh
```

(`maple.dev/cli/install` is [scripts/install.sh](../scripts/install.sh) served by
`apps/landing` — the build copies it to `public/cli/install`. The raw GitHub URL
`https://raw.githubusercontent.com/MapleTechLabs/maple/main/scripts/install.sh` works too.)

The manual installer detects your OS/arch, downloads the matching bundle from
the latest GitHub release, verifies its checksum, installs the two files into
`~/.maple/bin`, clears the macOS Gatekeeper quarantine, and symlinks `maple`
onto your PATH. Then:

```bash
maple start            # OTLP ingest + embedded ClickHouse on :4318; UI from local.maple.dev
maple start --offline  # …use the UI bundled in this binary (served from 127.0.0.1) instead
maple start -d         # …or detached; logs to ~/.maple/maple.log, stop with `maple stop`
maple services         # query the running server
maple traces
```

Local mode binds to `127.0.0.1` by default. To make the bundled dashboard and
APIs reachable from another machine, set a bind host explicitly and use the
same-origin offline UI:

```bash
MAPLE_LOCAL_BIND_HOST=0.0.0.0 \
MAPLE_LOCAL_ADVERTISE_HOST=maple.home.arpa \
  maple start --offline
# Equivalent: maple start --host 0.0.0.0 --advertise-host maple.home.arpa --offline
```

Binding outside loopback exposes the complete, unauthenticated local-mode
listener: OTLP ingest, `/local/query` raw SQL, `/health`, and the bundled UI.
Maple restricts browser requests to the advertised same-origin UI and the exact
configured hosted UI origin, but non-browser clients on the network still need
no credentials. Use it only on a trusted network or behind a TLS proxy with
browser-compatible authentication (for example, a session cookie or HTTP
authentication). The bundled UI does not inject a Bearer API key or propagate
an entry-page query parameter to its API requests. Open the advertised URL from
another machine; the default UI hosted at
`local.maple.dev` always talks to the browser machine's loopback address and is
therefore not suitable for a remote local-mode server.

By default `maple start` points you at the auto-updating dashboard hosted at
`local.maple.dev` (it talks back to this binary on loopback — see
[Where the UI comes from](#where-the-ui-comes-from)). `--offline` serves the copy
bundled into the binary instead, which also avoids the browser's local-network
permission prompt. The startup banner prints the right URL for the mode you chose.

Query commands accept `--format table` for an aligned table instead of JSON, and
`--debug` to print the compiled SQL + per-query timing to stderr (stdout stays
clean JSON). Pin the backend with `maple use local|remote` (or `auto` to clear).

Manual installer env overrides: `MAPLE_VERSION` (pin a release tag),
`MAPLE_INSTALL_DIR` (bundle location, default `~/.maple/bin`), `MAPLE_BIN_DIR`
(PATH symlink location), `MAPLE_SKIP_CHECKSUM=1` (skip SHA-256 verification —
only for air-gapped mirrors without the `.sha256`; not recommended).

### Updating

Update with the same tool you installed with:

```bash
brew upgrade maple
```

Homebrew installs are managed by Homebrew: the wrapper disables Maple's startup
update check and `maple update` exits with a reminder to use `brew upgrade
maple`.

Manual-installer builds keep themselves current:

- **Startup notice.** On any command, `maple` checks GitHub Releases for a newer
  version — at most **once per 24h** (the result is cached in
  `~/.maple/config.json` as `lastUpdateCheck` / `latestKnownVersion`, so every
  other run stays instant and offline). When a newer release exists it prints a
  one-line `update available` notice to stderr; it never changes behavior
  mid-run. The check is skipped for dev builds, non-interactive shells
  (CI/pipes), and the `--version`/`--help`/`update` paths. Opt out entirely with
  `MAPLE_NO_UPDATE_CHECK=1`.
- **`maple update`** downloads the latest release bundle, verifies its SHA-256,
  and installs it **in place** — an atomic rename over both files, safe even
  though the running binary is being replaced (the install dir's `cp`-based
  installer can't overwrite a running executable; the rename swaps the directory
  entry while the live process keeps its old inode). It then clears the macOS
  quarantine flag. Restart any running `maple start` afterward.
    - `maple update --check` — report current vs. latest without installing.
    - `maple update --tag <tag>` — install a specific release (e.g. `v0.6.0`); also
      the way to downgrade. (Named `--tag`, not `--version`, because the CLI
      reserves `--version` for printing the binary version.)

This is the same artifact the installer fetches, so `maple update` and re-running
`curl … | sh` are interchangeable.

### Uninstall

Homebrew:

```bash
brew uninstall maple
```

Manual installer:

```bash
curl -fsSL https://maple.dev/cli/uninstall | sh
```

The manual uninstaller removes the `maple` symlink and the `~/.maple/bin`
bundle. Your data dir (`~/.maple/data`) is kept unless you confirm its removal
when prompted. Honors the same `MAPLE_INSTALL_DIR` / `MAPLE_BIN_DIR` overrides
as the installer.

If you migrate from the manual installer to Homebrew, run the manual uninstaller
or remove the old PATH symlink so your shell resolves Homebrew's `maple`.

## Architecture: one Bun binary + libchdb

There is a single binary, `maple`, compiled from **`apps/cli`** (package
`@maple/cli`, Effect + Bun) with `bun build --compile`. It is both the CLI and
the server, and it talks to the embedded ClickHouse engine **directly via
`bun:ffi`** — no subprocess, no second language at the front:

| Concern              | Where                          | How                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI commands         | `apps/cli/src/commands`        | `maple services`, `traces`, `errors`, … run against **either** the local server **or** a remote workspace — every command bottoms out at the shared `WarehouseExecutor`, and only the executor layer swaps per [mode](#local-vs-remote-mode).                                                                                                                        |
| `maple start` server | `apps/cli/src/server/serve.ts` | A `Bun.serve` hosting OTLP/HTTP ingest (`POST /v1/{traces,logs,metrics}`), the query API (`POST /local/query`), and the bundled SPA — all on one port.                                                                                                                                                                                                               |
| Embedded ClickHouse  | `apps/cli/src/server/chdb.ts`  | `dlopen`s `libchdb` via `bun:ffi` (the `chdb_*` accessor C API) and holds a single connection for the process.                                                                                                                                                                                                                                                       |
| OTLP → rows          | `apps/cli/src/server/otlp/`    | Decodes OTLP protobuf/JSON (protobufjs) and encodes each signal to per-table NDJSON, matching the generated `local-inserts.json` schema exactly. Ported from the production Rust encoders so row shapes can't diverge.                                                                                                                                               |
| UI (SPA)             | `apps/local-ui` (Vite + React) | Hooks compile queries with `CH.compile(...)` and POST to `/local/query`. The same build is deployed to `local.maple.dev` (the default) **and** inlined into the binary as the `--offline` fallback (see [release bundle](#release-bundle)); it picks its query base URL from `window.location` at runtime (see [Where the UI comes from](#where-the-ui-comes-from)). |

chDB allows exactly one connection per process and isn't safe to call
concurrently — so the long-lived `maple start` process owns the connection, and
short-lived query commands (`maple traces`, …) reach it over HTTP via
[`executeLocalQuery`](../packages/query-engine/src/local.ts). `bun:ffi` calls are
synchronous and serialize naturally on the single JS thread, which preserves
chDB's single-writer requirement.

### Store lifecycle & recovery

The on-disk store at `~/.maple/data` is guarded by two sentinels beside it
(`apps/cli/src/server/store-version.ts`):

- **`maple-store-version.json`** — the chDB version and versioned Maple schema
  identity that bootstrapped the store. A different chDB build can't be trusted
  to reload another's persisted materialized views (it may crash the C++ runtime
  natively, which JS can't catch), so `maple start` **refuses up front** when the
  version differs. Current markers also carry a stable store id, immutable
  creation provenance, a full schema digest, and an `active`/`staging` state.
  Recover a store with an unsupported schema using `maple start --reset` only
  when losing its live telemetry is acceptable.
- **`maple-store-open`** — a clean-shutdown sentinel (not a concurrency lock; the
  PID file already guards that). It's written right after chDB opens and removed
  as the last step of a clean close. If `maple start` finds it still present over
  a populated store, the previous server died without closing cleanly and the
  store may be inconsistent — reopening could crash chDB natively. Rather than
  risk the crash, `maple start` **auto-wipes the store and bootstraps fresh**,
  printing a warning. Local telemetry data is **not recoverable** after an
  unclean kill of chDB; re-ingest to repopulate.

### Versioned local-store migrations

`maple start` never mutates a populated store in place when its schema identity
is stale. Inspect a supported path before choosing it:

```bash
maple schema status
maple schema plan
maple schema migrate --dry-run
maple schema migrate --yes
# If a pre-promotion target is dirty or incomplete:
maple schema abandon --yes
```

The supported legacy path is a stopped, side-by-side rebuild. It records a
cutoff, copies the six authoritative raw telemetry tables with explicit column
lists and bounded resumable batches, and replays the v1 materialized views from
rows inside each table's retention horizon. Source/target inventories
(row count, time bounds, and order-independent hashes) are compared before
promotion. The source is retained under `.maple-migrations/<id>/source/data` as
a pre-cutover rollback and inspection point; it is never deleted automatically.
Promotion is a durable multi-step rename within one filesystem. A source
directory mounted on another filesystem is rejected before cutover with an
`EXDEV`-safe retry message; the staged target and source remain available.

The migration journal beside the data directory is durable and fail-closed.
Each journal records the complete selected chain, current module step, frozen
source/target identities, typed module state, and resumable progress. A
migration connection writes `maple-store-open` before native connect/bootstrap
and clears it only after a clean close; a dirty source is never silently
reopened. Startup refuses to open an unfinished transaction until `maple
schema migrate --yes` resumes it. If the failure is before promotion, `maple
schema abandon --yes` validates the journal and source marker, then moves only
the journal-owned target and journal into a recoverable `.abandoned-*`
quarantine. The active source, its marker, checkpoints, and any retained
rollback source are left in place. A `promotion-started` journal is never
abandoned by this command because it may already contain a cutover; resume it
or use the explicit reset path after inspection. Promotion recovery runs from
the journal before ordinary active-marker compatibility checks, including the
crash window where the active marker is still `staging`.

After successful promotion, the canonical journal is archived under the
migration root as `journal.json`, so a completed v0 → v1 transaction cannot
short-circuit a later v1 → v2 migration. `maple start --reset` or `maple reset
--yes` can explicitly abandon an incomplete transaction, but preserves the
journal under an `maple-store-migration-abandoned-*` name for inspection.
Existing checkpoints remain attached to the retained source and are not
advertised as restorable by the new schema; create a fresh checkpoint after
promotion. Every persisted module state and progress value is decoded by its
own migration module before resume, and malformed journal topology fails
closed. A step marked `verified` is commit-pending: recovery may rewrite its
staging marker, but no module lifecycle handler runs again, including
`recover()`. Verified and completed steps must retain both decoded state and
progress. Target-only abandonment validates the coordinator-owned journal
structure and filesystem proofs without requiring the historical executable
module or its state decoder to remain available.

Migration edges are statically registered typed modules in
`apps/cli/src/server/local-store-migrations/`. The coordinator owns locking,
journaling, chain progression, staging, and promotion. Each module owns its
frozen schema identities, target preparation, transforms, semantic
verification, and typed recovery state. Adding a later edge should add a new
module and registry entry; the coordinator must not gain transition-specific
table names or branches. Later modules receive the previous staged target as
their `sourceDataDir` and the same staged store as `targetDataDir`, so their
transforms must be explicitly safe for this shared in-place topology. The
coordinator test seam exercises a two-edge chain, a resumed verified edge, and
one final promotion.

Structural identities live in the append-only history at
`apps/cli/src/server/local-schema-history.ts`. The schema gate checks the
current identity against the history tip, preserves the base branch's prior
entries in CI, and requires every historical identity to reach the current one
through registered migration edges. Changing a schema digest or manifest
therefore requires a new versioned entry and executable edge together.

The Linux native probe `apps/cli/test/native-local-store-migration.sh` uses a
native chDB setup helper to create a stopped historical raw-table fixture,
applies the legacy marker, runs the public migration command, checks rebuilt
service-namespace and database aggregates, and reopens the promoted store in
a fresh process. It reports `SKIP` when no native `libchdb` is available (for
example, on a development machine without the platform bundle); the Linux CI
bundle runs it alongside the checkpoint smoke test. The fixture covers the
authoritative v0 raw tables; retained derived objects remain rollback-only
rather than being treated as migrated history.

Every start also checks the opened physical schema against the generated local
schema manifest, including objects, columns/types/defaults/codecs, engines,
keys, TTLs, skipping indexes (with a DDL fallback on older chDB builds), and
materialized-view definitions.
This catches out-of-band or partially applied DDL even when a marker's bundle
digest looks current.
If a future migration needs a different chDB reader, its module must provide a
version-matched reader, a prior Maple binary/export path, or an explicit
unsupported boundary; the current binary never guesses by opening an
incompatible source.

## The `/local/query` contract

Clients POST `{ "sql": "..." }` and get back a bare JSON array of rows.

The **server owns the output FORMAT**. chDB runs SQL verbatim, and the handler
wraps line-delimited rows into a JSON array, so it always needs
`FORMAT JSONEachRow`. `CH.compile(...)` appends `FORMAT JSON`, so the handler
(`forceJsonEachRow` in `apps/cli/src/server/serve.ts`) strips any trailing
`FORMAT <ident>` the client sent and re-appends `FORMAT JSONEachRow`. Clients
therefore POST `compiled.sql` verbatim — no client-side format rewriting.

## Where the UI comes from

The dashboard SPA is a single build served two ways, and it decides which
`/local/query` base URL to use from `window.location` (`localApiBase()` in
[apps/local-ui/src/lib/constants.ts](../apps/local-ui/src/lib/constants.ts)):

- **Default — `local.maple.dev`.** `maple start` points you at the SPA deployed to
  `local.maple.dev` (a Cloudflare worker, `apps/local-ui/alchemy.run.ts`). This
  decouples UI updates from binary releases: ship a UI fix by deploying, no new
  binary. Because that page is a _public_ origin, its queries to
  `http://127.0.0.1:<port>/local/query` are a **public → loopback** request, which
  trips the browser's **Private Network Access** gate. The server answers the
  preflight with `Access-Control-Allow-Private-Network: true` only when the
  request origin exactly matches `MAPLE_LOCAL_UI_URL`; other cross-origin and
  unadvertised same-origin browser requests are rejected. Recent Chrome may
  still show a one-time "wants to access devices on your local network" prompt;
  Safari/Firefox differ. The banner encodes the bound port as `?port=` and adds
  `maple-local-api=loopback`, so custom hosted UI origins use the same routing.
- **`--offline` (and dev) — same origin.** The binary serves the bundled SPA from
  its selected bind address, so queries are same-origin even through a LAN
  hostname or reverse proxy: no CORS, no Private Network Access, no
  permission prompt, and it works with no internet. In dev the Vite server proxies
  `/local/*` to the binary, which is the same same-origin path. This is the
  recommended escape hatch whenever the default path hits a browser prompt.

Because the remote UI auto-updates independently of the binary, keep the
`/local/query` contract and the local chDB schema
([apps/cli/src/server/schema/local-schema.sql](../apps/cli/src/server/schema/local-schema.sql))
backward compatible — a newer UI may run against an older binary.

`MAPLE_LOCAL_UI_URL` overrides the default UI origin (e.g. point a binary at
`https://local-staging.maple.dev` for testing). The startup link marks that
custom origin as a hosted loopback client.

`MAPLE_LOCAL_BIND_HOST` sets the `maple start` listening address and defaults to
`127.0.0.1`; the `--host` flag overrides it for one invocation.
`MAPLE_LOCAL_ADVERTISE_HOST` (or `--advertise-host`) controls the client-facing
URL printed for wildcard binds. If omitted, wildcard IPv4/IPv6 binds advertise
their matching loopback address instead of the unusable `0.0.0.0` or `::`.

## Dev workflow

No Rust toolchain needed. Run the server and the SPA dev server in two terminals:

```bash
# Terminal 1 — the server (OTLP ingest + query API + chDB) on :4318.
# Needs libchdb: set MAPLE_LIBCHDB, or keep libchdb.so in ~/.maple/bin.
bun run apps/cli/src/bin.ts start

# Terminal 2 — the Vite SPA dev server on :4319, proxying /local → :4318
bun --filter @maple/local-ui dev
```

Open <http://127.0.0.1:4319>. Vite proxies `/local/*` to the server (override the
target with `MAPLE_LOCAL_URL`).

Query from the CLI against the same server:

```bash
bun run apps/cli/src/bin.ts services
bun run apps/cli/src/bin.ts traces --service api --since 1h
bun run apps/cli/src/bin.ts query "SELECT count() FROM traces"
```

In local mode the CLI derives its default target from `MAPLE_LOCAL_BIND_HOST`,
mapping wildcard binds to matching loopback. `MAPLE_LOCAL_URL` remains the
explicit override and is required when the server was started with a one-off
`--host` or non-default `--port` that later CLI processes cannot infer.

> **libchdb in dev.** `chdb.ts` resolves `libchdb` from, in order: `MAPLE_LIBCHDB`,
> a sibling of the executable, then `~/.maple/bin/libchdb.{so,dylib}`. Running from
> source uses the Bun executable's directory (no sibling libchdb), so either set
> `MAPLE_LIBCHDB` or drop a `libchdb.so` in `~/.maple/bin`.

## Local vs remote mode

The same CLI talks to a local server or a remote Maple workspace. The mode is
resolved per invocation:

1. `--remote` / `--local` flags (highest priority; usable as `maple <command> --local`).
2. `defaultMode` in `~/.maple/config.json`.
3. **Auto-detect**: a configured token ⇒ remote; otherwise a quick probe of
   `GET <local-url>/health` ⇒ local. If neither is available the CLI prints an
   actionable error.

Remote credentials use the macOS Keychain or Linux Secret Service when available,
with `~/.maple/config.json` (mode `0600`) as a fallback. Authentication is managed by:

```bash
maple auth login                               # browser + one-time device code
maple auth login --api-url https://api.example.com
maple auth login --with-token < token.txt      # non-interactive/manual fallback
maple auth status                              # validate the active login
maple auth logout                              # revoke browser-issued credentials and remove local state
```

`maple login`, `maple whoami`, and `maple logout` remain compatibility aliases.

Env overrides: `MAPLE_API_URL`, `MAPLE_API_TOKEN`, `MAPLE_LOCAL_URL`,
`MAPLE_LOCAL_BIND_HOST`, and `MAPLE_LOCAL_ADVERTISE_HOST`.

**How queries route.** Local mode compiles the pipe → SQL client-side and POSTs
it to `/local/query`. Remote mode does **not** compile pipes at all: it calls
Maple's public v2 API (`/v2/traces/*`, `/v2/logs/*`, `/v2/services`,
`/v2/service_map`, `/v2/metrics`) with the API key `maple auth login` stored,
and maps each response into the same output type the local path produces. The
branch lives in `apps/cli/src/core/operations.ts`; the v2 implementations are in
`core/remote-ops.ts`.

This replaced a generic `POST /api/tinybird/query` endpoint that let the client
name a pipe and have the server compile it. That endpoint has been retired — a
pipe name is an internal compiler detail, not a public contract, and shipping it
as one meant every CLI binary pinned the server's query catalog.

**Some commands are local-only.** Where v2 has no equivalent, the command fails
with the reason rather than returning a narrower answer:

| Command                             | Why it needs local mode                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `maple query "<sql>"`               | A raw-SQL passthrough against the multi-tenant warehouse would let a client read other orgs' data.               |
| `maple attributes keys` / `values`  | v2 exposes no attribute-discovery surface (`/v2/attribute_mappings` is mapping config, not observed keys).       |
| `maple slow-traces`                 | `/v2/traces/search` filters by minimum duration but cannot order by it.                                          |
| `maple top-ops`                     | Needs count, latency and error rate ranked together; `/v2/traces/breakdown` returns one aggregation per request. |
| `maple traces --span-name`          | v2 search returns root-based summaries, not matched spans. `--root-only` works remotely.                         |
| `maple errors` / `maple error <fp>` | v2 keys errors by an opaque `erris_…` issue id with no lookup from a fingerprint hash.                           |
| `maple compare`                     | v2 has no window-comparison endpoint.                                                                            |
| `maple diagnose`                    | Its error breakdown depends on the exception-type aggregates above.                                              |

Remote mode also inherits v2's pagination: lists cap at 100 rows per page and
seek by opaque cursor, so `--offset` is rejected rather than silently ignored.

### Seeding data

Send OpenTelemetry to the server's OTLP/HTTP endpoints
(`POST /v1/{traces,logs,metrics}`, protobuf or JSON, optionally gzip-encoded).
Most OTLP exporters default to protobuf and work out of the box.

For OTLP/JSON, `traceId`/`spanId`/`parentSpanId` follow the OTLP/JSON convention
— **hex strings** (32 chars for a trace id, 16 for a span id), the spec's
deliberate deviation from proto3 JSON, and what every OTel language SDK emits.
Base64 of the raw bytes (24 and 12 chars — the proto3 JSON encoding, and what
the protobuf path decodes to internally) is also accepted; the two are told
apart by length, so hand-written payloads work either way. Ids that decode to
any other length are rejected with a `400` naming the field, rather than stored
mangled: a hex trace id read as base64 yields a _deterministic_ 24-byte value,
so the trace still self-joins and looks correct right up until you compare it
against the emitting service's logs.

## Release bundle

`scripts/build-local-binary.sh` produces a relocatable **2-file bundle** (also built
per-platform by `.github/workflows/local-binary-release.yml`):

```
maple        # single Bun-compiled binary: CLI + ingest/query server + embedded SPA
libchdb.so   # the chDB engine (~320 MB), downloaded from chdb-io/chdb-core releases
```

The build (1) builds the SPA, (2) inlines `apps/local-ui/dist` into
`apps/cli/src/server/ui-embed.gen.ts` so `bun build --compile` bakes it into the
binary as the `--offline` fallback (the default UI is served from
`local.maple.dev`), (3) compiles `apps/cli`, and (4) downloads the matching `libchdb` beside
the binary. At runtime `maple` `dlopen`s the sibling `libchdb` (resolved relative
to its own path), so keep both files in the same directory — no `LD_LIBRARY_PATH`
or rpath tricks.

```bash
scripts/build-local-binary.sh               # full 2-file bundle into ./dist
```
