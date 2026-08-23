# Infrastructure notes

Background for the Alchemy stack (`alchemy.run.ts` + `apps/*/alchemy.run.ts` +
`packages/infra`). The stack files keep the rationale a reader needs **in order not to
break the code**; the history behind those decisions lives here, so the config stays
readable and the incidents stay findable.

If you are about to delete a comment in a stack file because "the history is in git" —
put it here instead. Git blame does not survive a refactor of the line it annotates.

## Layout

- `alchemy.run.ts` — the root stack. Composes one `create*` factory per app, resolves
  stage/domains, and returns the deploy summary (also emitted as GitHub step outputs).
- `apps/<app>/alchemy.run.ts` — one factory per deployable. Owns that app's resources and
  bindings, and nothing else's.
- `packages/infra` — stage/region/domain/naming logic and the shared deploy-time env
  groups. Pure functions, unit-tested, no cloud calls.
  - `cloudflare/stage.ts` — `MapleStage`, domains, worker names, Hyperdrive resolution.
  - `aws/stage.ts` — `MapleRegion`, AWS naming, task sizing, Cloud Map.
  - `env.ts` — `requireEnv` / `optionalPlain` / `optionalSecret` and the shared env
    groups the workers spread.

## Local dev, and the `alchemy dev` question

Local dev runs through **wrangler** today (`bun dev` → turbo → per-app `wrangler dev`
behind the portless `.localhost` proxy). That is why each Worker app carries a
`wrangler.jsonc` alongside its `alchemy.run.ts`, and why crons, DO classes, KV bindings and
rate limiters are declared twice. The duplication is real and has already drifted:
`apps/api/wrangler.jsonc` declares one of the three rate limiters the stack deploys.

`alchemy dev` is the obvious way out — one definition, no mirroring. **Spiked 2026-08-23,
result: promising but not yet proven.** What was established, running
`alchemy dev spike.run.ts --stage dev_spike` against a throwaway stack containing only
`apps/electric-sync`, with `ALCHEMY_LOCAL_STATE=1`:

- It works end to end at the stack level. Alchemy reconciled the Worker, wrote
  `.alchemy/state/…/electric-sync.json` with `status: "created"`, and **started workerd**,
  which listened on `localhost:1337`. No account state was touched.
- The rendered bindings were correct, including the stage-derived `MAPLE_ENVIRONMENT:
  "development"` and the correct *absence* of every unset optional key.
- **But nothing served.** Every request to `localhost:1337` timed out (`curl` exit 28)
  even after the resource reached `created`. The port was open; the request path was not.
  Not diagnosed — could be the spike stack, the missing `ELECTRIC_URL`, or dev-mode
  routing.

So it is not a "flip the switch" migration. Before committing, finish the spike and answer:

- Why did the open port not serve? That is the blocker.
- Do KV, DO (+ SQLite migrations), Workflows, `RateLimit`, `send_email`, the Queues
  consumer and Assets all resolve locally? `Cloudflare/Local.ts` registers local providers
  for Workers, Containers, Queues, Consumers, D1 and Secrets Store — **the rest of that
  list is unverified**, and it is most of what `apps/api` binds.
- Does it coexist with the portless proxy and `turbo dev`, or does it want to own the
  process tree? Each Worker takes a `dev: { host, port, strictPort }`, which maps onto the
  existing per-app ports, so this looks tractable.
- Is `@alchemy.run/cloudflare-runtime` (a dependency of alchemy, pinned to the same beta)
  stable enough to sit under everyone's dev loop?

**Until that lands**, do not hand-fix the mirroring — make it self-policing. A CI check
that parses each `wrangler.jsonc` and asserts its crons, DO class names, KV bindings and
rate-limit namespace ids match what the app's `create*` factory declares turns a silent
drift into a failing build, and stays useful right up until the wrangler files are deleted.

## The AWS opt-in flag (`MAPLE_DEPLOY_AWS_INGEST`)

The Rust OTLP gateway (`apps/ingest`) moved from Railway to ECS Fargate. The flag gates
both `AWS.providers()` and the ingest resources.

It is often mistaken for dead code. It is not — see the comment on `DEPLOY_AWS_INGEST` in
`alchemy.run.ts` for the two live reasons (it is the staging cost gate, and the providers
Layer is built before the stage is readable).

**The #378 hang.** The flag was *also* introduced because turning the AWS half on wedged
every production deploy with no log line and no network I/O. The cause was alchemy's
env-credential path (`CI=true`): it discovered the account with an STS `GetCallerIdentity`
issued while its own `AWSEnvironment` was still being constructed, and that call waited on
the half-built environment for its endpoint resolver — a self-deadlock. Supplying
`AWS_ACCOUNT_ID` skips the lookup. Reproduced locally with `CI=true` and the id unset, on
alchemy 2.0.0-beta.64 through beta.74. The deploy workflows now set it. This part is fixed
and is no longer a reason the flag exists.

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

## Cost decisions

These are cash-flow calls, not design ones, and should be revisited rather than treated as
architecture:

- **No NAT gateway** in the ingest VPC. NAT bills $0.045/GB *processed* on top of egress,
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
  that deploys the gateway, at ~$13.5/mo per stage at the non-prd size. `MAPLE_DEPLOY_AWS_COLLECTOR=1`
  opts a single deploy in, which is how it was verified on Fargate before it reached prod.
- **PR previews get no database and no ingest fleet.** PlanetScale PR branches billed
  continuously and consumed the account's Hyperdrive config cap; a VPC + ALB per PR is real
  money for a stack nothing points at. `resolveDatabaseMode` returns `"none"` for `pr`, so
  DB-backed routes 500 and the rest of the preview works. The reverse path is documented on
  that function.
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
  the listener on 3474, which Cloudflare's proxy does not forward to, *and* drops `port`
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
  gitignore rules *without* rebasing root-anchored ones onto the context dir —
  `/apps/ingest/target` becomes the glob `apps/ingest/target/**` evaluated with
  `cwd=apps/ingest`, matching nothing. The whole target dir would be walked and hashed on
  every deploy.
- **A first deploy of a new stage with the AWS half on.** The ACM certificate lands
  `PENDING_VALIDATION` and the 443 listener fails. The workflows recover by creating the
  validation CNAME (`scripts/ingest-cert-validate.sh`) and redeploying; the script is a
  no-op on an ISSUED certificate.
