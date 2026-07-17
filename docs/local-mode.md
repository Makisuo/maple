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
`https://raw.githubusercontent.com/Makisuo/maple/main/scripts/install.sh` works too.)

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

- **`maple-store-version.json`** — the chDB version that bootstrapped the store.
  A different chDB build can't be trusted to reload another's persisted
  materialized views (it may crash the C++ runtime natively, which JS can't
  catch), so `maple start` **refuses up front** when the version differs.
  Recover with `maple start --reset`.
- **`maple-store-open`** — a clean-shutdown sentinel (not a concurrency lock; the
  PID file already guards that). It's written right after chDB opens and removed
  as the last step of a clean close. If `maple start` finds it still present over
  a populated store, the previous server died without closing cleanly and the
  store may be inconsistent — reopening could crash chDB natively. Rather than
  risk the crash, `maple start` **auto-wipes the store and bootstraps fresh**,
  printing a warning. Local telemetry data is **not recoverable** after an
  unclean kill of chDB; re-ingest to repopulate.

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

Remote credentials live in `~/.maple/config.json` (mode `0600`), managed by:

```bash
maple login --api-url https://api.maple.dev   # paste the token when prompted (or --token / stdin)
maple whoami                                   # show the resolved mode + target
maple logout                                   # forget the stored token
```

Env overrides: `MAPLE_API_URL`, `MAPLE_API_TOKEN`, `MAPLE_LOCAL_URL`,
`MAPLE_LOCAL_BIND_HOST`, and `MAPLE_LOCAL_ADVERTISE_HOST`.

**How queries route.** Local mode compiles the pipe → SQL client-side and POSTs
it to `/local/query`. Remote mode POSTs `{ pipe, params }` to the API's
`POST /api/tinybird/query`, where the server compiles it with the
authenticated tenant's org id (the client never sends `org_id`). Both paths use
the same `@maple/query-engine` dispatcher, so results are identical.

**`maple query "<sql>"` is local-only.** A generic raw-SQL passthrough against
the multi-tenant cloud warehouse would let a client read other orgs' data, so
in remote mode it returns a clear error. Every other command works in both modes.

### Seeding data

Send OpenTelemetry to the server's OTLP/HTTP endpoints
(`POST /v1/{traces,logs,metrics}`, protobuf or JSON, optionally gzip-encoded).
Most OTLP exporters default to protobuf and work out of the box. For OTLP/JSON,
trace and span IDs follow the OTLP/JSON convention (hex strings).

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
