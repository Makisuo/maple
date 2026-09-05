# Infrastructure notes

Background for the Alchemy stack (`alchemy.run.ts` + `apps/*/alchemy.run.ts` +
`packages/infra`). The stack files keep the rationale a reader needs **in order not to
break the code**; the history behind those decisions lives here, so the config stays
readable and the incidents stay findable.

If you are about to delete a comment in a stack file because "the history is in git" —
put it here instead. Git blame does not survive a refactor of the line it annotates.

## Layout

- `alchemy.run.ts` — the root stack. Provides `MapleStack` (stage, domains, public URLs,
  the `bun dev` blocks) once, yields one module per app, and returns the deploy summary
  (also emitted as GitHub step outputs).
- `apps/<app>/src/worker.ts` — a Worker as one module: the alchemy Worker class the root
  yields, whose props are an Effect over `MapleStack`, and the bundle alchemy deploys
  (`alerting`, `electric-sync`, `landing`, `local-ui`; see "Single-module Workers" below).
- `apps/<app>/alchemy.run.ts` — a `create*` factory, only where the Worker still takes
  another resource as an argument (`api`, `web`) or the app is not a Worker (`ingest`,
  `electric` on ECS). Owns that app's resources and bindings and nothing else's.
- `packages/infra` — stage/region/domain/naming logic, the shared deploy-time env groups,
  and the few resources several Worker modules bind.
    - `cloudflare/stage.ts` — `MapleStage`, domains, worker names, Hyperdrive resolution.
      Pure functions, unit-tested, no cloud calls.
    - `cloudflare/stack.ts` — `MapleStack`, what the root stack tells the Worker classes.
    - `cloudflare/maple-db.ts` / `cloudflare/observability.ts` — the managed Hyperdrive
      and the Workers Observability destinations, declared once and yielded from every
      module that binds them (alchemy registers a resource by id; a second yield returns
      the first's).
    - `aws/stage.ts` — `MapleRegion`, AWS naming, task sizing, Cloud Map.
    - `env.ts` — the deploy-time env primitives and the shared groups the workers spread.
    - `config-helpers.ts` / `cloudflare/worker-runtime.ts` / `cloudflare/workers-cache.ts` /
      `cloudflare/r2.ts` — the _runtime_ (in-Worker) side, each behind its own subpath
      export so a worker bundle never reaches the deploy graph through `./cloudflare`.

**Read deploy-time config through `@maple/infra/env`, not `process.env`.** Alchemy resolves
config through a ConfigProvider built as `fromDotEnv(--env-file ?? ".env")` **orElse**
`fromEnv()` (`alchemy/Util/ConfigProvider.ts`), and never copies the file-sourced values
into `process.env`. A `process.env` read therefore silently ignores `.env` and
`--env-file` — and does so _selectively_, since alchemy's own settings
(`CLOUDFLARE_ACCOUNT_ID`, `CI`, …) still pick them up, so half the deploy sees the file and
half does not. `Config` also reports every missing key in one pass instead of throwing on
the first, and keeps the failure in the typed error channel. `packages/alchemy-maple`'s
`MapleEnvironment` is the same pattern inside a provider; the runtime worker env schemas
use `@maple/infra/config-helpers`, which `env.ts` builds on.

## Local dev: one `alchemy dev` stack

`bun dev` (`scripts/dev.ts`) runs the whole local stack as a single `alchemy dev`:

```bash
bun dev             # everything
bun dev api web     # a subset: api, alerting, electric-sync, web, landing, ingest, local-ui, scraper
```

The Workers — **api, alerting, electric-sync** — are served by alchemy's local runtime from
the same `create*` factories that deploy them. Everything that is not a Worker — web, landing
and local-ui (vite/astro dev servers), ingest (`cargo run`) and scraper — runs as a
`Command.Dev` child of the same stack: each app's own `dev` script, started by
`createDevProcess` in `alchemy.run.ts`, kept alive across stack restarts, stopped with the
stack. `Command.Dev` is a no-op on a deploy, so this is dev-only by construction; the asset
Workers' deploy shape (`Command.Build` + assets Worker) never runs in dev.

Portless provides what alchemy's local runtime does not: named HTTPS hosts that several
worktrees share without anyone caring about ports. The routes are alchemy resources —
`Portless.Route` from `lib/alchemy-portless`, one per app the run serves (`createDevRoute`).
A route reserves a loopback port, registers `portless alias <hostname> <port>`, and removes
the route again when it is torn down: with the dev session, on a config change, or on
`alchemy destroy`. Its `port` attribute feeds a child process's `PORT` like any other Output;
a Worker binds its port at plan time (`Portless.workerDev`) and its route follows the Worker. The
provider lives in alchemy's dev sidecar, so a route survives a hot reload of the stack file.

**Ports are sticky, not pinned.** A route prefers a port derived from its identity (a hash
into 40000–49999; Workers use 50000–59999 so the two can never collide), walks forward if that
one is held (a second worktree running the same app), and only then takes an OS-chosen port. So `api` lands on the same port run after run
without anyone writing it down, and two checkouts never fight over one. Linked worktrees get
the branch-prefixed hostnames portless itself produces (last branch segment, none for `main`:
`fix-ui.api.localhost`), and
each non-Worker child is told its own name through `PORTLESS_URL`, which is how the
vite/astro configs find the api and ingest (`siblingUrl`).

What is left in `scripts/dev.ts` is a shim: `bun dev api web` → `MAPLE_DEV_APPS=api,web`, then
`alchemy dev`. A subset run still declares every resource (a resource absent from the plan
would be deleted from the account); it only leaves the other Workers unserved
(`dev: { mode: "external" }`) and starts no child process for them. The inter-app URLs are
handed to the Workers as env by the stack itself, so `.env.local` cannot override them.

`isDevServer` (`ALCHEMY_DEV=true`, set by `alchemy dev`) is what switches the stack into this
shape, and `MAPLE_DEV_APPS` narrows it to the requested apps. Neither is stage-derived: a dev
_stage_ can still be deployed to the cloud, and a deploy is never partial.

What this buys over the old per-app `wrangler dev` under turbo + portless:

- **One definition.** Bindings, crons and exported classes come from `alchemy.run.ts`, for
  dev and deploy alike. There are no `wrangler.jsonc` files any more; the crons/DO/KV/
  rate-limiter mirroring that used to drift between the two is gone with them. `wrangler`
  survives only as an `apps/api` devDependency for `bench:startup-cpu`, whose `worker` mode
  writes a throwaway config for `wrangler check startup`.
- **One process tree.** No turbo fan-out, no per-app `portless` wrapper, no `dev:app`
  indirection: `bun dev` is the stack, and Ctrl-C stops all of it.
- **Crons fire on their real schedule.** `alchemy dev` runs each Worker's declared crons
  itself, and `/cdn-cgi/handler/scheduled` triggers one on demand (Miniflare's path, always
  on — no `--test-scheduled` flag).
- **Almost everything is emulated locally.** Workers, KV, R2, Hyperdrive, queues + consumers,
  Durable Objects, Workflows, rate limiters and `send_email` (written as `.eml` files under
  `.alchemy/local/email/`) all come up `(local)`; storage lives under `.alchemy/local/`.
  The AI Gateway is the one resource still created live in the account.

Gotchas worth knowing:

- **The dev Hyperdrive origin must set `sslmode: "disable"`.** Alchemy defaults a local
  origin to `sslmode=prefer` (`Cloudflare/Hyperdrive/ConnectBinding.ts`), the driver then
  attempts TLS against the docker Postgres, which has SSL off, and every DB call 503s with
  `CONNECT_TIMEOUT` after the dial budget. See `createManagedMapleDb`.
- **`MAPLE_OTEL_INGEST_KEY` is optional on dev stages only** (`selfObservabilityEnv`). The
  local stack resolves the same env contract as a deploy, and no developer has a real
  ingest key; without the exemption the whole stack refuses to start over a key whose only
  job is exporting the Worker's own telemetry.
- Dev stacks run with `ALCHEMY_LOCAL_STATE=1`, so they never touch the account state store.
- `--env-file .env.local` is read once at start: a changed variable needs a restart.
- The children's logs share one terminal. There are no per-app panes as under turbo's TUI.
- A harness that cannot resolve `*.localhost` (the browser-verification preview) uses the
  sticky raw ports `bun dev` prints; `Portless.Route`'s `port` prop pins one outright.
- Ctrl-C stops the whole tree: the shim runs alchemy in its own process group and forwards
  the signal to the group, because alchemy's CLI is several node processes deep and a signal
  to any one of them stops nothing. The routes come off as alchemy tears the session down.
- If portless is not installed or its proxy is down, a route logs a warning and the app is
  reachable on `127.0.0.1:<port>` only; the inter-app URLs still name the `*.localhost`
  hosts, so start the proxy (`portless proxy start`) rather than work around it.

## Single-module Workers

A Worker is one module, `apps/<app>/src/worker.ts`: the alchemy Worker class the root stack
yields (`export default class Alerting extends Cloudflare.Worker<Alerting>()("alerting",
props, impl) {}`) and the bundle alchemy builds (`main: import.meta.url`). `props` is an
Effect that reads `MapleStack` (`@maple/infra/cloudflare`, provided once by the root from
`Alchemy.Stage`) and yields whatever other resources the Worker binds — its `Command.Build`,
the shared `ManagedMapleDb` or `WorkersObservabilityDestinations` (alchemy registers a
resource by id, so a second module yielding the same one gets the first's). `impl` runs once
per isolate on the first event and returns the handlers. No hand-written `export default
{ fetch }`, no per-app `alchemy.run.ts`, no factory arguments. electric-sync, alerting,
landing and local-ui ship this way.

What each kind of Worker keeps beside the module:

- **Crons** (`alerting`): `Cloudflare.Workers.cron(expression, handler)` in `impl`, under
  `CronEventSourceLive`, attaches the schedule at plan time and the listener at runtime.
  The source reports every fire as successful, so the platform's retry never engages — and
  nothing is lost: the ticks already log and swallow their own failures, the schedules
  re-fire, and the shell logs a failure outside a tick. The ticks live in `src/scheduled.ts`
  behind a dynamic import, so the api layer graph is off the startup path and out of the
  deploy process (where `impl` also runs), and the test imports it without a runtime.
- **Assets** (`landing`, `local-ui`): the handler reads `Cloudflare.Workers.Request` and
  `env.ASSETS` and hands the web `Response` back through `HttpServerResponse.fromWeb`.
  landing's negotiation is a plain function in `src/handler.ts` for the same test reason.
- **The stg/prd Hyperdrive bound by id** (`alerting`, `api`): alchemy has no `env` form for a
  binding it did not create (its own `Hyperdrive.Connect` attaches the same raw metadata),
  so the root stack calls `bindMapleDbRef` after the yield.

Still factories: `api` (its Durable Object and Workflow classes are exported from the async
entry, and `web` needs its Worker value for the service binding) and `web` (takes `api`);
`ingest` and `electric` are ECS services. Alchemy has Effect-native Workflows and a Queues
event source, so api is the next conversion, and `web` follows once its props can
`yield* Api`.

Alchemy evaluates that module in three places — the deploy process, `alchemy dev`, and the
deployed isolate — and two rules keep it honest about which one it is in:

- **Props are a plan-time Effect, guarded for the bundle.** The stage-derived props (`name`,
  `domain`, `env`, the portless `dev` block) read `MapleStack` (`@maple/infra/cloudflare`), a
  service the root stack provides once from `Alchemy.Stage`, so the module never imports
  portless or parses the stage itself. Alchemy also evaluates props inside the deployed
  bundle, where they are inert, so the props Effect returns early under
  `globalThis.__ALCHEMY_RUNTIME__` — alchemy's bundler folds it to `true`, and the stack-side
  branch plus the `@maple/infra` modules only it reaches are dead-code-eliminated. Check by
  grepping the bundle under `.alchemy/bundles/electric-sync/` for a `maple.dev` hostname.
- **The app layer is built on the first request, not in init.** `impl` (init) also runs at
  plan time, and alchemy's plan-time ConfigProvider auto-binds every `Config` it sees read
  during init onto the Worker as a secret — which would override the explicit `env` contract
  (a PR preview deliberately gets no `ELECTRIC_URL`). So the route graph is dynamic-imported
  and built once per isolate on the first `fetch` (`Effect.cached`), against a scope that is
  never closed: workerd has no isolate teardown, so nothing in the layer may need releasing.

What it costs: the root stack imports the worker module, so the Alchemy-entrypoints
typecheck (`tsconfig.alchemy.json`) covers electric-sync's runtime graph and needs
`@maple-dev/effect-sdk` built first and `@maple/electric-sync` installed in the quality
shard (`ci.yml`). Measured on the pilot (#745, local workerd A/B): +15ms startup CPU
(41→56ms, budget ~1s), ~+8ms cold first request, ~+0.2ms/request warm.

## The retired AWS opt-in flag (`MAPLE_DEPLOY_AWS_INGEST`)

The Rust OTLP gateway (`apps/ingest`) moved from Railway to ECS Fargate. While the
cut-over was in flight, `MAPLE_DEPLOY_AWS_INGEST=1` gated both `AWS.providers()` and the
ingest resources, so an unset variable produced a byte-identical pure-Cloudflare stack.

**The flag is gone (2026-08).** ECS is the only ingest path now, so the gate had nothing
left to protect: `AWS.providers()` is registered unconditionally (it cannot be
stage-derived — the `Alchemy.Stack` options are evaluated before `Alchemy.Stage` is
readable inside the stack effect), and `stageDeploysIngest` alone decides which stages get
a fleet. It covers prd, stg **and PR previews**; dev stages run the gateway through
docker-compose. The spend gate moved to where the spend is: a preview only exists while
its PR carries the `preview` label.

Do not reintroduce a global on/off env flag for this. If a stage should not have a fleet,
say so in `stageDeploysIngest`, where it is typed, unit-tested and visible in review.

**The #378 hang.** The flag was _also_ introduced because turning the AWS half on wedged
every production deploy with no log line and no network I/O. The cause was alchemy's
env-credential path (`CI=true`): it discovered the account with an STS `GetCallerIdentity`
issued while its own `AWSEnvironment` was still being constructed, and that call waited on
the half-built environment for its endpoint resolver — a self-deadlock. Supplying
`AWS_ACCOUNT_ID` skips the lookup. Reproduced locally with `CI=true` and the id unset, on
alchemy 2.0.0-beta.64 through beta.74. The deploy workflows now set it — **every workflow
that deploys the stack must**, including `deploy-pr-preview.yml`.

**Why the binary is compiled outside the image build.** Alchemy's docker build passes no
`--cache-from`, and a fresh runner's layer cache is empty, so a Dockerfile that runs
`cargo build` recompiles all 385 crates on every deploy however the layers are arranged.
Cold cost is **2m54s, measured** — an earlier version of this note guessed ~20 minutes,
which was wrong by ~7x and had already been quoted back as fact in a code review, so treat
the number as load-bearing. The workflow compiles inside `rust:1.94-bookworm` rather than
on the runner because the runtime base is `debian:bookworm-slim` (glibc 2.36) while
`ubuntu-24.04` ships 2.39 — a host-built binary dies with `version 'GLIBC_2.39' not found`.

## Hyperdrive: why api and alerting have separate configs

Measured over 6h on prd: `alerting` issued 60,688 Postgres queries/hour against the api's
1,415 — 97% versus 2%. Sharing one Hyperdrive config meant sharing one origin connection
pool, and the api spent its time queueing behind the alerting crons. A dial that found a
free slot took 12ms; one that did not stalled until Hyperdrive's 15s connection timeout,
which is what put `maple-api`'s p99 at 15.4s.

The two configs **partition** the origin's connections rather than creating more: the
per-config `origin_connection_limit`s sum against the branch's `max_connections`, and
Hyperdrive will not coordinate between them, so over-provisioning one starves the other at
the database rather than at the pool.

**Open item — staging points at production.** `resolveHyperdriveRefId` returns the prd
config for `stg` (owner decision, 2026-07-14). stg workers therefore read and write the
production database, and the stg alerting crons overlap prod's. `MAPLE_ALERTING_ALLOW_NONPROD`
exists to keep those crons off for exactly this reason. Fixing it means a PlanetScale `stg`
branch plus dedicated `maple-stg` / `maple-alerting-stg` dashboard configs, split per
consumer the same way prd is — and then a deliberate decision about whether stg crons
should run.

## The cold-start regression (`strictExecutionOrder: false`)

alchemy ≥ beta.70 sets rolldown `strictExecutionOrder: true`, which wraps ~every chunk in a
lazy `__esmMin` initializer. The DB module graph (drizzle `pgTable` schemas + Effect Schema
ASTs) then evaluates on first use — inside the first Postgres call of each fresh isolate —
instead of at script startup. That stepped the cold dial from ~2s to ~9-11s on 2026-08-08
(deploy 2679ba80) and produced the CONNECT_TIMEOUT incident; see the 2026-08-11
investigation.

The override in `apps/api/alchemy.run.ts` moves that cost back to script startup, off the
request path. If chunking ever regresses into upstream #749 (`ScriptStartupError: Cannot
access '<minified>' before initialization`), the deploy fails loudly at upload — remove the
override and warm the DB graph off the request path instead.

## Alchemy v1 → v2 notes

The stack was written against alchemy v1 and migrated to v2. Equivalences worth knowing
when reading old code or docs:

- **`HyperdriveRef` has no v2 equivalent.** Binding a dashboard-managed config by ID is
  done by attaching raw `{ type: "hyperdrive", name, id }` binding metadata after the
  Worker exists (`worker.bind(...)`) — the same mechanism the env binder uses. No cloud
  resource is created and the origin credentials stay in the dashboard.
- **`Ai()` became an AI Gateway resource.** v2 emits the `{ type: "ai" }` binding by
  attaching `Cloudflare.AI.Gateway`, which also fronts model calls with caching,
  rate-limits and logging. The deploy token needs account-level "AI Gateway: Edit".
- **`eventSources` became `Queues.Consumer`.** The consumer is a sibling resource pointing
  at the worker by `scriptName`.
- **Resource attributes are lazy Outputs.** `worker.url` and friends cannot be
  string-interpolated at plan time. This is why every deployed stage gets custom domains
  (`resolveMapleDomains`) and why inter-app URLs are plain strings chosen by the stack
  rather than read off resources.
- **DO classes are SQLite-backed by default** in v2.
- **The vendored runtime lib is gone.** `lib/effect-cloudflare` was a hand-copied subset of
  `alchemy-effect`'s `Cloudflare/Workers/*`, from before that package shipped; ~1600 of its
  2520 lines had no consumer at all (the DO/Workflow/RPC/KV/fetcher/websocket cluster —
  apps/api's own DO and Workflows extend `cloudflare:workers` directly). It was deleted; the
  ~250 lines with consumers live in `packages/infra` behind runtime-only subpaths
  (`/worker-runtime`, `/workers-cache`, `/r2`, `/config-helpers`).
- **Alchemy's runtime services are not importable from a hand-written Worker entry.** The
  obvious follow-up — drop our `WorkerEnvironment` and import alchemy's — does not work
  today. Its exports map has no entry finer than a directory (`./Cloudflare/*` →
  `*/index.ts`), and the `Cloudflare/Workers` barrel re-exports `Source.ts` /
  `WorkerProvider.ts` / `LocalWorkerProvider.ts` next to the two runtime services, so
  bundling it pulls `fdir`, rolldown glue and Node builtins: **426 KB minified against 14 KB
  for the tag alone**, and `node:module` does not exist in workerd. Same for `R2`, `KV` and
  service-binding clients, which additionally want the deploy-side resource value and the
  `Worker` service (`makeBucketBinding` indexes `env[bucket.LogicalId]`). All of it comes
  for free the day api/alerting move to the class-form `Cloudflare.Worker` and let alchemy's
  bundler generate the entry — that is the migration these are waiting on. Until then
  `packages/infra/src/cloudflare/worker-env.ts` defines the tag under alchemy's exact key
  (`"Cloudflare.Workers.WorkerEnvironment"`), so both resolve to the same service.

## Cost decisions

These are cash-flow calls, not design ones, and should be revisited rather than treated as
architecture:

- **No NAT gateway** in the ingest VPC. NAT bills $0.045/GB _processed_ on top of egress,
  and the gateway exists to push gzipped telemetry outbound — at current volume NAT alone
  would cost more than the compute and the egress combined, and it scales linearly with
  growth. Tasks therefore carry public IPs, which is why the security-group split between
  the ALB and the tasks is load-bearing rather than tidy. The S3 gateway endpoint keeps ECR
  image pulls off the public path and is free.
- **Same-region Tinybird.** AWS bills $0.09/GB to the public internet but $0.01/GB to a
  public IP in the same region, and export traffic dwarfs every other line item — at 200k
  req/s that is ~$83k/mo vs ~$16k/mo. A workspace on `https://api.tinybird.co` is GCP
  Frankfurt, where NO AWS region colocates and the move costs more than Railway did.
  Verify `TINYBIRD_HOST` before changing `resolveAwsRegion`.
- **The OTel collector is prd-only** (`stageDeploysCollector`). The intent is every stage
  that deploys the gateway, at ~$13.5/mo per stage at the non-prd size. Adding the
  `preview:collector` label to a PR sets `MAPLE_DEPLOY_AWS_COLLECTOR=1` for that preview,
  which is how it was verified on Fargate before it reached prod.
- **PR previews get an ingest fleet, but no database.** PlanetScale PR branches billed
  continuously and consumed the account's Hyperdrive config cap, so `resolveDatabaseMode`
  returns `"none"` for `pr`: DB-backed routes 500 and the rest of the preview works. The
  reverse path is documented on that function. The AWS half _is_ deployed — a preview gets
  its own VPC + ALB + ECS fleet, which is real money, so it only runs while the PR carries
  the `preview` label and is destroyed the moment the label comes off or the PR closes.
  A preview has no ingest domain, so its ALB answers plain HTTP on 80 with no ACM
  certificate; the URL is posted on the PR comment. There is no longer a separate
  on-demand ingest preview stack (`scripts/ingest-preview.run.ts` and
  `deploy-pr-ingest.yml` are deleted) — two alchemy stacks claiming the same
  `maple-ingest-pr-<n>` physical names is how orphan fleets accumulate.
- **x86_64, not Graviton.** Flipping `cpuArchitecture` to `"ARM64"` is the whole switch
  (~20% cheaper) but needs an ARM builder: cross-compiling Rust under QEMU is 10-30 min a
  build, for single-digit dollars a month at this size. Revisit with an ARM runner.

## Things that have broken a deploy before

Short list; each has a comment at the site.

- A **relative `dockerfile`** path. Alchemy has flipped how it resolves one between
  releases — `ECR.Image` joins it onto `context`, the ECS image source (beta.73+) resolves
  it against the cwd — and each flip broke the deploy. Absolute paths pass through both.
- **`listenerPort` vs `port`** on `ECS.Service`. `port` is the container port; the listener
  defaults to 443 once `certificateArn` is set. Setting `listenerPort: INGEST_PORT` puts
  the listener on 3474, which Cloudflare's proxy does not forward to, _and_ drops `port`
  back to alchemy's default 3000 while the gateway binds 3474 — so no target ever passes
  `/health`.
- **A security group that does not admit the listener port.** A stage without an ingest
  domain gets an HTTP listener on 80, not 443. The first preview deploy came up healthy and
  timed out on every request for exactly this reason.
- **An arm64 image on an X86_64 task** — fails at start with "image Manifest does not
  contain descriptor matching platform 'linux/amd64'". Hence the explicit
  `runtimePlatform`.
- **A cargo `--target-dir` inside the image context.** Alchemy hashes the context with
  `hashDirectory`, which has no `.dockerignore` support and derives exclusions from
  gitignore rules _without_ rebasing root-anchored ones onto the context dir —
  `/apps/ingest/target` becomes the glob `apps/ingest/target/**` evaluated with
  `cwd=apps/ingest`, matching nothing. The whole target dir would be walked and hashed on
  every deploy.
- **A first deploy of a new stage with the AWS half on** used to fail: each service's ACM
  certificate landed `PENDING_VALIDATION` and its 443 listener refused it, and the
  workflows recovered by publishing the validation CNAMEs with a script and deploying
  again. `@maple/infra/acm` now does that inside the stack — it resolves the Cloudflare
  zone from the certificate's own hostname, publishes the CNAME ACM asks for, and blocks
  the listener on `ISSUED` — so a new certificate-bearing service needs no registration
  anywhere and no second pass. The remaining manual record is the **proxied CNAME at the
  ALB** for each public service, which the deploy output names.
