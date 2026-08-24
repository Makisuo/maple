import { existsSync } from "node:fs"
import { resolve } from "node:path"
import * as AWS from "alchemy/AWS"
import * as Output from "alchemy/Output"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import type { MapleRegion } from "@maple/infra/aws"
import {
	COLLECTOR_DNS_LABEL,
	COLLECTOR_OTLP_HTTP_PORT,
	resolveAwsRegion,
	resolveAwsResourceName,
	resolveCollectorEndpoint,
	resolveCollectorTaskSize,
	resolveIngestCidrBlock,
	resolveIngestDesiredCount,
	resolveIngestNamespaceName,
	resolveIngestScaling,
	resolveIngestTaskSize,
	stageDeploysCollector,
} from "@maple/infra/aws"
import type { ReplayBlobCredentials } from "../api/alchemy.run.ts"
import type { MapleDomains, MapleStage } from "@maple/infra/cloudflare"
import { resolveDeploymentEnvironment } from "@maple/infra/cloudflare"
// Only the primitives. The grouped helpers in that module return Worker-binding
// shapes (Redacted secrets inline); these values feed ECS `env:` and Secrets
// Manager ARNs instead, so the gateway composes them itself.
import { optionalPlain, requiredPlain } from "@maple/infra/env"

/**
 * Binary the deploy workflows compile ahead of time (with a warm cargo cache)
 * so the image build is a COPY rather than a from-scratch build of 385 crates.
 * Present in CI, absent on a dev machine — see `Dockerfile.prebuilt`.
 */
const PREBUILT_BINARY = "apps/ingest/dist/maple-ingest"
/**
 * Absolute on purpose. alchemy has flipped how a relative `dockerfile` is
 * resolved between releases — `ECR.Image` joins it onto `context`, while the
 * ECS image source (beta.73+) resolves it against the cwd, "NOT the context"
 * — and each flip broke the deploy. An absolute path passes through both
 * rules untouched. The stack already assumes cwd = repo root (see
 * PREBUILT_BINARY).
 */
const PREBUILT_DOCKERFILE = resolve("apps/ingest/Dockerfile.prebuilt")

/**
 * The OTel collector that runs beside the gateway. Its own directory, NOT
 * `apps/ingest`: that is the gateway's build context, and a collector config
 * change would otherwise rebuild and roll the gateway. Not `otel/` either —
 * that is the Railway collector, which Railway redeploys on any change there.
 * Same absolute-dockerfile rule as PREBUILT_DOCKERFILE.
 */
const COLLECTOR_CONTEXT = "packages/infra/otel-collector"
const COLLECTOR_DOCKERFILE = resolve(COLLECTOR_CONTEXT, "Dockerfile")

/** Port the gateway binds (`apps/ingest/Dockerfile` EXPOSEs the same). */
const INGEST_PORT = 3474

/**
 * WAL cap, deliberately well below Fargate's 20 GB of included ephemeral
 * storage — that 20 GB also holds the image and the OS, and the gateway's own
 * default (`INGEST_QUEUE_MAX_BYTES` = 20 GiB, `apps/ingest/src/main.rs`) would
 * sit exactly on the line. 8 GiB still buys hours of buffering at current
 * volume; raising it means paying for ephemeral storage beyond the free tier.
 */
const WAL_MAX_BYTES = 8 * 1024 * 1024 * 1024

/**
 * Pinned rather than derived. The gateway defaults to `num_cpus * 2`, which
 * makes on-disk layout and fd count a function of task size — so a cpu bump, or
 * a move to another capacity provider, would silently reshape the WAL. Two lanes per shard
 * (Tinybird + ClickHouse) means this is 8 open WAL files.
 */
const WAL_SHARDS = 4

export interface CreateMapleIngestOptions {
	stage: MapleStage
	domains: MapleDomains
	/** Geographic instance. Every AWS resource here is scoped to it. */
	region: MapleRegion
	/**
	 * Stack-minted R2 credentials for the replay payload store, or `undefined`
	 * on a stage that keeps payloads inline. See `createReplayBlobStore` in
	 * `apps/api/alchemy.run.ts` — the gate is `stageEnablesReplayBlobs`.
	 */
	replayBlobs: ReplayBlobCredentials | undefined
}

/**
 * The Rust OTLP gateway (`apps/ingest`) on ECS Fargate.
 *
 * Migrated off Railway. Fargate rather than EC2 because below ~16 vCPU the
 * fractional-vCPU pricing beats EC2 on-demand and there is no ASG or AMI to
 * own; the two are capacity providers on the same cluster, so crossing that
 * threshold later is a config change, not a rearchitecture. (EC2 would also not
 * buy the per-task CPU/memory metrics it is sometimes reached for: the free
 * cluster-level ECS metrics are `CPUReservation`/`MemoryReservation`, which
 * describe how much of a fleet YOU own is claimed. Per-task usage needs
 * Container Insights on either launch type.) Tasks run on ARM64 — see
 * `runtimePlatform` below.
 *
 * One fleet per `MapleRegion`. A second instance is this factory called again
 * with `region: "eu"` and that instance's own TINYBIRD_* / MAPLE_PG_URL — the
 * resources below carry no cross-region references, so the two never touch.
 *
 * The fleet is two services in one cluster: the gateway behind the public ALB,
 * and an OTel collector (`packages/infra/otel-collector`) that the gateway
 * reaches by Cloud Map private DNS. The collector carries the gateway's own
 * traces/metrics/usage metrics (and customer OTLP only when INGEST_WRITE_MODE
 * is forward/dual) to Tinybird. It sits in the same VPC for the same reason the
 * gateway does — its export egress is the same-region $0.01/GB rate — and it
 * has no load balancer: an internal ALB would bill the same bytes again for a
 * single private consumer, and Cloud Map costs a private hosted zone.
 */
export const createMapleIngest = ({ stage, domains, region, replayBlobs }: CreateMapleIngestOptions) =>
	Effect.gen(function* () {
		const taskSize = resolveIngestTaskSize(stage)
		const scaling = resolveIngestScaling(stage)
		const name = (base: string) => resolveAwsResourceName(base, stage, region)

		// Public subnets with public IPs on the tasks, and NO NAT gateway. NAT
		// bills $0.045/GB PROCESSED on top of egress, and this service exists to
		// push gzipped telemetry outbound — at current volume NAT alone would cost
		// more than the compute and the egress combined, and it scales linearly
		// with growth. The S3 gateway endpoint keeps ECR image pulls (S3-backed)
		// off the public path and is free.
		const network = yield* AWS.EC2.Network("ingest-network", {
			cidrBlock: resolveIngestCidrBlock(region),
			availabilityZones: 2,
			nat: "none",
			gatewayEndpoints: ["s3"],
			tags: { Service: "maple-ingest", Region: region },
		})

		// Two groups, because `AWS.ECS.Service` applies `securityGroups` to BOTH the
		// ALB and the tasks — there is no separate knob for the load balancer. Both
		// are attached to both, and the split lives in the RULES: the internet
		// reaches 443 (the ALB listener), and INGEST_PORT is reachable only from
		// something already in the ALB group.
		//
		// This matters more here than it would behind a NAT: the tasks carry public
		// IPs so they can egress without one, so an ENI's address is directly
		// dialable. Opening INGEST_PORT to 0.0.0.0/0 would let anyone who finds it
		// post OTLP straight to a task over plaintext HTTP, skipping the ALB and,
		// since the domain is proxied, Cloudflare's TLS and rate limiting with it.
		// The public listener port follows the certificate: with an ingest domain
		// the ALB terminates TLS on 443; a stage without one (PR previews) gets
		// alchemy's default HTTP listener on 80, and the group has to admit THAT
		// port or the load balancer is unreachable (the first preview deploy came
		// up healthy and timed out on every request for exactly this reason).
		const listenerPort = domains.ingest ? 443 : 80
		const albSecurityGroup = yield* AWS.EC2.SecurityGroup("ingest-alb-sg", {
			vpcId: network.vpcId,
			groupName: name("ingest-alb"),
			description: `Maple OTLP ingest - public ${listenerPort === 443 ? "HTTPS" : "HTTP"} to the load balancer`,
			ingress: [
				{
					ipProtocol: "tcp",
					fromPort: listenerPort,
					toPort: listenerPort,
					cidrIpv4: "0.0.0.0/0",
					description:
						listenerPort === 443
							? "OTLP over HTTPS"
							: "OTLP over HTTP (no ingest domain, no certificate)",
				},
			],
		})

		const taskSecurityGroup = yield* AWS.EC2.SecurityGroup("ingest-sg", {
			vpcId: network.vpcId,
			groupName: name("ingest"),
			description: "Maple OTLP ingest gateway",
			ingress: [
				{
					ipProtocol: "tcp",
					fromPort: INGEST_PORT,
					toPort: INGEST_PORT,
					referencedGroupId: albSecurityGroup.groupId,
					description: "ALB to task",
				},
			],
		})

		const cluster = yield* AWS.ECS.Cluster("ingest-cluster", {
			clusterName: name("ingest"),
			tags: { Service: "maple-ingest", Region: region },
		})

		// Real credentials go through Secrets Manager, not `env`: ECS stores task
		// definition environment variables in plaintext, readable by anyone with
		// `ecs:DescribeTaskDefinition`. Alchemy grants the execution role
		// `secretsmanager:GetSecretValue` on exactly these ARNs.
		const secret = (id: string, value: string) =>
			AWS.SecretsManager.Secret(id, {
				name: `${name("ingest")}/${id}`,
				secretString: Redacted.make(value),
				tags: { Service: "maple-ingest", Region: region },
			})

		/**
		 * Same, for a value that does not exist until another resource does —
		 * `secret` above takes a plan-time string, this takes an alchemy Output.
		 */
		const secretFrom = (id: string, value: Output.Output<Redacted.Redacted<string>>) =>
			AWS.SecretsManager.Secret(id, {
				name: `${name("ingest")}/${id}`,
				secretString: value,
				tags: { Service: "maple-ingest", Region: region },
			})

		const tinybirdToken = yield* secret("tinybird-token", yield* requiredPlain("TINYBIRD_TOKEN"))
		// Deliberately NOT `MAPLE_PG_URL`. That one is the direct-5432 admin URL the
		// deploy workflows use for DDL; the gateway must reach Postgres through
		// PSBouncer (6432) as a role that only reads ingest keys. Sharing the name
		// would silently hand every task the migration admin's credentials.
		const pgUrl = yield* secret("maple-pg-url", yield* requiredPlain("MAPLE_INGEST_PG_URL"))
		const keyEncryptionKey = yield* secret(
			"ingest-key-encryption-key",
			yield* requiredPlain("MAPLE_INGEST_KEY_ENCRYPTION_KEY"),
		)
		const keyLookupHmacKey = yield* secret(
			"ingest-key-lookup-hmac-key",
			yield* requiredPlain("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY"),
		)

		// Optional credentials — absent in a stage that hasn't enabled the feature.
		// Autumn absent means billing enforcement is dark.
		const autumnKey = process.env.AUTUMN_SECRET_KEY?.trim()
		const autumnSecret = autumnKey ? yield* secret("autumn-secret-key", autumnKey) : undefined

		// Replay blob storage. Both halves of the credential are stack-minted now
		// (`createReplayBlobStore`), so there is no half-set configuration to guard
		// against any more — the whole group arrives together or not at all, and
		// `stageEnablesReplayBlobs` is what decides which.
		//
		// The ACCESS KEY ID goes through Secrets Manager alongside the secret, even
		// though it is not sensitive: it is the API token's id, which does not exist
		// until the token is created, and ECS task-definition `env` takes plan-time
		// strings only. ECS injects `secrets` into the container as environment
		// variables, so `AppConfig::from_env` reads it exactly as before.
		const replayR2Secret = replayBlobs
			? yield* secretFrom("replay-r2-secret-access-key", replayBlobs.secretAccessKey)
			: undefined
		const replayR2AccessKeyId = replayBlobs
			? yield* secretFrom("replay-r2-access-key-id", Output.map(replayBlobs.accessKeyId, Redacted.make))
			: undefined

		// ── OTel collector ──────────────────────────────────────────────────
		// prd only for now (`stageDeploysCollector` — a cash-flow call; the intent
		// is every gateway stage). MAPLE_DEPLOY_AWS_COLLECTOR=1 forces it on for
		// one deploy, which is how a preview tests it. Without a collector the
		// gateway keeps whatever forward endpoint the deploy env supplies — its
		// self-telemetry goes nowhere reachable, exactly as before.
		const deployCollector = stageDeploysCollector(stage) || process.env.MAPLE_DEPLOY_AWS_COLLECTOR === "1"
		const collectorEndpoint = deployCollector ? resolveCollectorEndpoint(stage, region) : undefined
		const collector = deployCollector
			? yield* Effect.gen(function* () {
					// Reachable only from the gateway's task group, on the OTLP/HTTP port.
					// The tasks still carry public IPs (ECR API, Secrets Manager and Tinybird
					// are all reached over the internet — no NAT, see `network`), so without
					// this rule the receiver would be dialable from anywhere.
					const collectorSecurityGroup = yield* AWS.EC2.SecurityGroup("otel-collector-sg", {
						vpcId: network.vpcId,
						groupName: name("otel-collector"),
						description: "Maple OTel collector - OTLP/HTTP from the ingest gateway tasks",
						ingress: [
							{
								ipProtocol: "tcp",
								fromPort: COLLECTOR_OTLP_HTTP_PORT,
								toPort: COLLECTOR_OTLP_HTTP_PORT,
								referencedGroupId: taskSecurityGroup.groupId,
								description: "Ingest gateway to collector",
							},
						],
					})

					// Private DNS for the fleet. The gateway finds the collector as
					// `otel-collector.<namespace>` — both labels are chosen here rather than
					// generated by AWS, which is what lets `resolveCollectorEndpoint` hand the
					// gateway a plain string at plan time. (alchemy's `serviceRegistry:` sugar
					// would generate the Cloud Map service name, so the Cloud Map service is
					// created explicitly and wired through the raw `serviceRegistries`.)
					// A records, because awsvpc tasks register by ENI address; ECS manages
					// instance health, hence `healthCheckCustomConfig`.
					const namespace = yield* AWS.CloudMap.PrivateDnsNamespace("ingest-dns", {
						name: resolveIngestNamespaceName(stage, region),
						vpc: network.vpcId,
						description: "Maple ingest fleet - private service discovery",
						tags: { Service: "maple-ingest", Region: region },
					})
					const collectorDiscovery = yield* AWS.CloudMap.Service("otel-collector-discovery", {
						name: COLLECTOR_DNS_LABEL,
						namespaceId: namespace.namespaceId,
						description: "Maple OTel collector",
						dnsRecords: [{ type: "A", ttl: "10 seconds" }],
						healthCheckCustomConfig: { failureThreshold: 1 },
						tags: { Service: "maple-ingest", Region: region },
					})

					const collectorTaskSize = resolveCollectorTaskSize(stage)
					return yield* AWS.ECS.Service("otel-collector", {
						cluster,
						serviceName: name("otel-collector"),

						// A two-line Dockerfile over the pinned upstream contrib image with the
						// config baked in; the context hash covers only that directory, so the
						// image is rebuilt when the config or the pin changes and never
						// otherwise. The ghcr `otel-collector-maple` image is deliberately NOT
						// used: it is the customer-facing ClickHouse build (no `tinybird`
						// exporter) and cannot run this config.
						context: COLLECTOR_CONTEXT,
						dockerfile: COLLECTOR_DOCKERFILE,
						// Graviton, same as the gateway. Nothing to rebuild for it: the
						// upstream contrib image is multi-arch.
						runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
						cpu: collectorTaskSize.cpu,
						memory: collectorTaskSize.memory,

						// One task: it carries self-telemetry, and the gateway's OTLP exporters
						// retry in memory across a collector restart. No container health
						// check — the upstream image is a static binary on scratch, nothing to
						// run one with; ECS restarts the task on process exit and Cloud Map
						// registration follows task state.
						desiredCount: 1,
						vpcId: network.vpcId,
						subnets: network.publicSubnetIds,
						securityGroups: [collectorSecurityGroup.groupId],
						assignPublicIp: true,
						port: COLLECTOR_OTLP_HTTP_PORT,
						serviceRegistries: [{ registryArn: collectorDiscovery.serviceArn }],

						logging: { retention: "30 days" },

						// The same Tinybird target and token the gateway writes with.
						secrets: { TINYBIRD_TOKEN: tinybirdToken.secretArn },
						env: { TINYBIRD_HOST: yield* requiredPlain("TINYBIRD_HOST") } satisfies Record<
							string,
							string
						>,

						tags: { Service: "maple-ingest", Region: region },
					})
				})
			: undefined

		// An ALB can only use a certificate from its OWN region, and the ACM
		// resource otherwise defaults to us-east-1 (the CloudFront requirement).
		// Derived from the Maple region so the cert can never drift from where the
		// ALB actually lands — CI must set AWS_REGION to the same value, since
		// that is what `AWS.providers()` places every other resource with.
		//
		// Without `hostedZoneId` the provider does not block on issuance, so the
		// first deploy of a new stage lands the certificate PENDING_VALIDATION;
		// add the DNS validation record in Cloudflare, then re-run to attach the
		// listener once ACM reports ISSUED.
		const certificate = domains.ingest
			? yield* AWS.ACM.Certificate("ingest-cert", {
					domainName: domains.ingest,
					validationMethod: "DNS",
					region: resolveAwsRegion(region),
					tags: { Service: "maple-ingest", Region: region },
				})
			: undefined

		const service = yield* AWS.ECS.Service("ingest", {
			cluster,
			serviceName: name("ingest"),

			// Alchemy creates a private ECR repository and pushes under a content-hash
			// tag, rebuilding only when the context hash changes — so a deploy that
			// doesn't touch apps/ingest never builds at all.
			//
			// When it DOES build, the Dockerfile depends on where we are. CI compiles
			// the binary in a separate, cached step and leaves it at dist/, so the
			// image build is a COPY (~30s). A dev machine has no dist/, so it falls
			// back to the self-contained source build. Keyed on the file rather than
			// on `process.env.CI` so a local run that happens to have built the binary
			// gets the fast path too, and so CI can never silently ship a stale one.
			// `dockerfile` is absolute — see PREBUILT_DOCKERFILE for why a relative
			// path here has broken the deploy in both directions.
			context: "apps/ingest",
			...(existsSync(PREBUILT_BINARY) ? { dockerfile: PREBUILT_DOCKERFILE } : undefined),
			// Graviton. AWS's own ARM cores, ~20% cheaper per vCPU-hour on Fargate at
			// comparable per-core performance for this workload (gzip + protobuf
			// decode), and the saving grows with the autoscaler rather than being a
			// one-off.
			//
			// The docker build platform is DERIVED from this (`taskImagePlatform` in
			// alchemy's ECS/Task) — there is no separate `platform` prop — so it also
			// dictates what the binary inside has to be. A mismatch is not a build
			// error: the task pulls, starts and dies with `exec format error`, or the
			// pull itself fails with "image Manifest does not contain descriptor
			// matching platform". CI compiles aarch64 natively on an `ubuntu-24.04-arm`
			// runner (`.github/workflows/build-ingest-binary.yml`, free on public
			// repos); a local `alchemy deploy` from an Apple Silicon machine is also
			// native. An x86 machine would emulate the source build — slow, but
			// correct.
			runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
			cpu: taskSize.cpu,
			memory: taskSize.memory,

			desiredCount: resolveIngestDesiredCount(stage),
			// prd autoscales on CPU between this count and a burst ceiling; alchemy
			// stops pinning desiredCount while `scaling` is set, so the autoscaler's
			// decisions survive redeploys. Other stages stay fixed.
			...(scaling ? { scaling } : undefined),
			vpcId: network.vpcId,
			subnets: network.publicSubnetIds,
			securityGroups: [albSecurityGroup.groupId, taskSecurityGroup.groupId],
			assignPublicIp: true,

			public: true,
			// `port` is the CONTAINER port (what the target group forwards to); the
			// listener port is separate and defaults to 443 once `certificateArn` is
			// set, which is what we want. Setting `listenerPort: INGEST_PORT` instead
			// would break twice over: the listener would sit on 3474, which
			// Cloudflare's proxy does not forward to (it only fetches origins on its
			// supported port list), and `port` would fall back to alchemy's default
			// of 3000 while the gateway binds 3474 — so no target would ever pass
			// `/health` and the service would never stabilize.
			port: INGEST_PORT,
			healthCheckPath: "/health",
			...(certificate ? { certificateArn: certificate.certificateArn } : undefined),

			// `/health` returns a bare 200 with no dependency checks, so it detects a
			// dead task but not a wedged export lane or a dead Postgres pool. The
			// grace period covers the startup Postgres probe, which exits the
			// process on failure rather than serving degraded.
			healthCheckGracePeriod: "60 seconds",

			logging: { retention: "30 days" },

			secrets: {
				TINYBIRD_TOKEN: tinybirdToken.secretArn,
				MAPLE_PG_URL: pgUrl.secretArn,
				MAPLE_INGEST_KEY_ENCRYPTION_KEY: keyEncryptionKey.secretArn,
				MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: keyLookupHmacKey.secretArn,
				...(autumnSecret ? { AUTUMN_SECRET_KEY: autumnSecret.secretArn } : undefined),
				...(replayR2Secret && replayR2AccessKeyId
					? {
							INGEST_REPLAY_R2_SECRET_ACCESS_KEY: replayR2Secret.secretArn,
							INGEST_REPLAY_R2_ACCESS_KEY_ID: replayR2AccessKeyId.secretArn,
						}
					: undefined),
			},

			env: {
				INGEST_PORT: String(INGEST_PORT),
				MAPLE_ENVIRONMENT: resolveDeploymentEnvironment(stage),
				TINYBIRD_HOST: yield* requiredPlain("TINYBIRD_HOST"),
				INGEST_KEY_STORE_BACKEND: "postgres",

				// Trust `Cf-IPCountry` on inbound requests, which is what gates
				// `derive_country` in `apps/ingest/src/main.rs` and therefore whether
				// `session_replays.Country` is ever non-empty. Safe here specifically
				// because the ALB security group only admits Cloudflare's proxy ranges
				// (see `albSecurityGroup` above), so the header cannot be
				// client-supplied. Left unset until now, which is why every session
				// recorded before this deploy has `Country = ''` — the gateway never
				// stores a client IP, so there is nothing to backfill from.
				MAPLE_INGEST_TRUST_PROXY_GEO: "true",

				INGEST_QUEUE_MAX_BYTES: String(WAL_MAX_BYTES),
				INGEST_WAL_SHARDS: String(WAL_SHARDS),

				// Replay blobs stay on Cloudflare R2 rather than S3. Measured at
				// $0.002/session, the two land within ~$0.0001 of each other: R2
				// charges nothing for egress but pays AWS internet egress on the way
				// in, while S3 writes free from this region and then bills $0.09/GB
				// back out on every playback. What actually dominates either bill is
				// per-object PUTs (~65%), because the SDK flushes a chunk every 100 KB
				// — so the lever is `FLUSH_BYTES`, not the vendor. S3 would also need a
				// SigV4 or presigned read path in the Worker, which does not exist
				// (`apps/api/src/platform/ReplayBlobStore.ts` uses the native R2
				// binding).
				//
				// Endpoint and bucket are plan-time strings; the two credential halves
				// arrive through `secrets` above. See `createReplayBlobStore`.
				...(replayBlobs
					? {
							INGEST_REPLAY_R2_ENDPOINT: replayBlobs.endpoint,
							INGEST_REPLAY_R2_BUCKET: replayBlobs.bucket,
							...(yield* optionalPlain("INGEST_REPLAY_R2_REGION", "auto")),
						}
					: undefined),

				// The gateway's own traces / operational metrics / usage metrics go
				// here (`init_tracing`, `init_metrics`, `init_usage_metrics` in
				// `apps/ingest/src/main.rs`), and customer OTLP too when
				// INGEST_WRITE_MODE is forward/dual. Owned by the stack rather than
				// read from Infisical: that value names the Railway-internal
				// collector, which is unreachable from this VPC — and was why the
				// AWS tasks' self-telemetry never arrived before the collector moved
				// in here. Not loopback, so the gateway's recursion guard stays out
				// of the way.
				...(collectorEndpoint
					? { INGEST_FORWARD_OTLP_ENDPOINT: collectorEndpoint }
					: yield* optionalPlain("INGEST_FORWARD_OTLP_ENDPOINT")),
				// Every optional entry below is `yield*`-ed. `optionalPlain` returns a
				// `Config`, not a record, so a bare `...optionalPlain("X")` spreads the
				// Config's own fields (`_tag`, `original`, `mapOrFail`) into the task
				// definition and drops X entirely — which is what this block did until
				// now: none of these variables ever reached an ECS task, and the type
				// checker let it pass because alchemy's `env` accepts wider values.
				...(yield* optionalPlain("INGEST_WRITE_MODE")),
				...(yield* optionalPlain("INGEST_BATCH_MAX_ROWS")),
				...(yield* optionalPlain("INGEST_BATCH_MAX_BYTES")),
				...(yield* optionalPlain("INGEST_BATCH_MAX_WAIT_MS")),
				...(yield* optionalPlain("INGEST_ORG_QUEUE_MAX_BYTES")),
				...(yield* optionalPlain("INGEST_ORG_MAX_IN_FLIGHT")),
				...(yield* optionalPlain("INGEST_MAX_REQUEST_BODY_BYTES")),
				...(yield* optionalPlain("INGEST_EXPORT_MAX_ATTEMPTS")),
				...(yield* optionalPlain("INGEST_TINYBIRD_CONCURRENCY_PER_SHARD")),
				...(yield* optionalPlain("INGEST_REPLAY_MAX_SESSION_BYTES")),
				// The org Maple's own telemetry is filed under. Required here and in
				// the gateway (`AppConfig::from_env`), with no fallback on either
				// side: the old `"internal"` default did not disable self-telemetry,
				// it wrote traces, logs and metrics into the warehouse under an
				// `OrgId` no org owns and no UI can read. The AWS fleet spent its
				// first day looking like it had lost its self-telemetry for exactly
				// that reason. A missing value now fails the deploy rather than the
				// task, which is the earlier and cheaper of the two.
				MAPLE_INTERNAL_ORG_ID: yield* requiredPlain("MAPLE_INTERNAL_ORG_ID"),
				...(yield* optionalPlain("AUTUMN_API_URL")),
				...(yield* optionalPlain("COMMIT_SHA", process.env.GITHUB_SHA?.trim())),
				// `satisfies` rather than a bare literal: alchemy types `env` as
				// `Record<string, any>`, which is what let a spread `Config` object
				// through unnoticed. Pinning the literal to string values makes that
				// mistake a type error instead of a silently dropped variable.
			} satisfies Record<string, string>,

			tags: { Service: "maple-ingest", Region: region },
		})

		return {
			serviceUrl: service.url,
			// `http://otel-collector.<namespace>:4318` — resolvable only inside the
			// VPC; surfaced so a preview's logs say where the gateway is pointing.
			collectorEndpoint,
			collectorServiceName: collector?.serviceName,
			// One-time manual DNS, surfaced here so it is discoverable from the
			// deploy output rather than the AWS console:
			//   1. the ACM validation CNAME (below) — added once per domain, reused
			//      for every renewal;
			//   2. a CNAME for `domains.ingest` at `serviceUrl` (the ALB), proxied.
			// Both live in the Cloudflare `maple.dev` zone, which this stack does
			// not otherwise touch.
			certificateValidation: certificate?.domainValidationOptions,
		}
	})
