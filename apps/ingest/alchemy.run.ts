import { existsSync } from "node:fs"
import * as AWS from "alchemy/AWS"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import type { MapleRegion } from "@maple/infra/aws"
import {
	resolveAwsRegion,
	resolveAwsResourceName,
	resolveIngestCidrBlock,
	resolveIngestDesiredCount,
	resolveIngestTaskSize,
} from "@maple/infra/aws"
import type { MapleDomains, MapleStage } from "@maple/infra/cloudflare"
import { resolveDeploymentEnvironment } from "@maple/infra/cloudflare"

/**
 * Binary the deploy workflows compile ahead of time (with a warm cargo cache)
 * so the image build is a COPY rather than a from-scratch build of 385 crates.
 * Present in CI, absent on a dev machine — see `Dockerfile.prebuilt`.
 */
const PREBUILT_BINARY = "apps/ingest/dist/maple-ingest"

const requireEnv = (key: string): string => {
	const value = process.env[key]?.trim()
	if (!value) {
		throw new Error(`Missing required deployment env: ${key}`)
	}
	return value
}

const optionalPlain = (key: string, fallback?: string): Record<string, string> => {
	const value = process.env[key]?.trim() || fallback
	return value ? { [key]: value } : {}
}

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
 * makes on-disk layout and fd count a function of task size — so a Fargate to
 * EC2 move, or a cpu bump, would silently reshape the WAL. Two lanes per shard
 * (Tinybird + ClickHouse) means this is 8 open WAL files.
 */
const WAL_SHARDS = 4

export interface CreateMapleIngestOptions {
	stage: MapleStage
	domains: MapleDomains
	/** Geographic instance. Every AWS resource here is scoped to it. */
	region: MapleRegion
}

/**
 * The Rust OTLP gateway (`apps/ingest`) on ECS Fargate.
 *
 * Migrated off Railway. Fargate rather than EC2 because below ~16 vCPU the
 * fractional-vCPU pricing beats EC2 on-demand and there is no ASG or AMI to
 * own; the two are capacity providers on the same cluster, so crossing that
 * threshold later is a config change, not a rearchitecture.
 *
 * One fleet per `MapleRegion`. A second instance is this factory called again
 * with `region: "eu"` and that instance's own TINYBIRD_* / MAPLE_PG_URL — the
 * resources below carry no cross-region references, so the two never touch.
 */
export const createMapleIngest = ({ stage, domains, region }: CreateMapleIngestOptions) =>
	Effect.gen(function* () {
		const taskSize = resolveIngestTaskSize(stage)
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
		const albSecurityGroup = yield* AWS.EC2.SecurityGroup("ingest-alb-sg", {
			vpcId: network.vpcId,
			groupName: name("ingest-alb"),
			description: "Maple OTLP ingest — public HTTPS to the load balancer",
			ingress: [
				{
					ipProtocol: "tcp",
					fromPort: 443,
					toPort: 443,
					cidrIpv4: "0.0.0.0/0",
					description: "OTLP over HTTPS",
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

		const tinybirdToken = yield* secret("tinybird-token", requireEnv("TINYBIRD_TOKEN"))
		// Deliberately NOT `MAPLE_PG_URL`. That one is the direct-5432 admin URL the
		// deploy workflows use for DDL; the gateway must reach Postgres through
		// PSBouncer (6432) as a role that only reads ingest keys. Sharing the name
		// would silently hand every task the migration admin's credentials.
		const pgUrl = yield* secret("maple-pg-url", requireEnv("MAPLE_INGEST_PG_URL"))
		const keyEncryptionKey = yield* secret(
			"ingest-key-encryption-key",
			requireEnv("MAPLE_INGEST_KEY_ENCRYPTION_KEY"),
		)
		const keyLookupHmacKey = yield* secret(
			"ingest-key-lookup-hmac-key",
			requireEnv("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY"),
		)

		// Optional credentials — absent in a stage that hasn't enabled the feature.
		// Autumn absent means billing enforcement is dark.
		const autumnKey = process.env.AUTUMN_SECRET_KEY?.trim()
		const autumnSecret = autumnKey ? yield* secret("autumn-secret-key", autumnKey) : undefined

		// Replay blob storage keys off the ENDPOINT, matching the gateway's own
		// switch (`Config::from_env` in `apps/ingest/src/main.rs` treats
		// INGEST_REPLAY_R2_ENDPOINT as the enable flag and `required()`s the rest).
		// Gating on any other variable inverts the contract: a deploy holding the
		// endpoint, bucket and access key but missing the secret would drop the
		// endpoint from the task env, and the gateway — seeing no R2 config at all —
		// would silently fall back to storing replay payloads inline. That is the
		// exact failure the Rust guard exists to prevent, so the check moves here:
		// endpoint set means the deploy fails now rather than the tasks crash-loop
		// later.
		const replayR2Endpoint = process.env.INGEST_REPLAY_R2_ENDPOINT?.trim()
		const replayR2Secret = replayR2Endpoint
			? yield* secret("replay-r2-secret-access-key", requireEnv("INGEST_REPLAY_R2_SECRET_ACCESS_KEY"))
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
			// `dockerfile` is resolved relative to `context`, NOT to the cwd — despite
			// one doc comment upstream saying otherwise, `ImageProps` and
			// `AWS/ECR/Image.ts:225` both join it onto the context. A repo-root path
			// here produced `apps/ingest/apps/ingest/Dockerfile.prebuilt` and failed
			// the deploy outright; caught by deploying the real thing through
			// scripts/aws-probe.run.ts.
			context: "apps/ingest",
			...(existsSync(PREBUILT_BINARY) ? { dockerfile: "Dockerfile.prebuilt" } : undefined),
			// The docker build platform is derived from this (`taskImagePlatform` in
			// alchemy's ECS/Task). Explicit so a build from an Apple Silicon machine
			// produces the same artifact CI does — an arm64 image on an X86_64 task
			// fails at start with "image Manifest does not contain descriptor
			// matching platform 'linux/amd64'". Flipping cpuArchitecture to "ARM64"
			// is the whole Graviton switch (~20% cheaper), but it needs an ARM
			// builder: cross-compiling Rust under QEMU is 10-30 min a build, for
			// single-digit dollars a month at this size. Revisit with an ARM runner.
			runtimePlatform: { cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX" },
			cpu: taskSize.cpu,
			memory: taskSize.memory,

			desiredCount: resolveIngestDesiredCount(stage),
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
				...(replayR2Secret
					? { INGEST_REPLAY_R2_SECRET_ACCESS_KEY: replayR2Secret.secretArn }
					: undefined),
			},

			env: {
				INGEST_PORT: String(INGEST_PORT),
				MAPLE_ENVIRONMENT: resolveDeploymentEnvironment(stage),
				TINYBIRD_HOST: requireEnv("TINYBIRD_HOST"),
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

				// Replay blobs stay on Cloudflare R2. The AWS egress this costs is
				// single-digit dollars a month; moving them to S3 would save nothing
				// and would require a SigV4 or presigned read path in the Worker
				// (`apps/api/src/platform/ReplayBlobStore.ts` uses the native R2
				// binding). `requireEnv` on the companions rather than
				// `optionalPlain`, so a half-set config fails the deploy instead of
				// reaching a task that refuses to boot.
				...(replayR2Endpoint
					? {
							INGEST_REPLAY_R2_ENDPOINT: replayR2Endpoint,
							INGEST_REPLAY_R2_BUCKET: requireEnv("INGEST_REPLAY_R2_BUCKET"),
							INGEST_REPLAY_R2_ACCESS_KEY_ID: requireEnv("INGEST_REPLAY_R2_ACCESS_KEY_ID"),
							...optionalPlain("INGEST_REPLAY_R2_REGION", "auto"),
						}
					: undefined),

				...optionalPlain("INGEST_WRITE_MODE"),
				...optionalPlain("INGEST_FORWARD_OTLP_ENDPOINT"),
				...optionalPlain("INGEST_BATCH_MAX_ROWS"),
				...optionalPlain("INGEST_BATCH_MAX_BYTES"),
				...optionalPlain("INGEST_BATCH_MAX_WAIT_MS"),
				...optionalPlain("INGEST_ORG_QUEUE_MAX_BYTES"),
				...optionalPlain("INGEST_ORG_MAX_IN_FLIGHT"),
				...optionalPlain("INGEST_MAX_REQUEST_BODY_BYTES"),
				...optionalPlain("INGEST_EXPORT_MAX_ATTEMPTS"),
				...optionalPlain("INGEST_TINYBIRD_CONCURRENCY_PER_SHARD"),
				...optionalPlain("INGEST_REPLAY_MAX_SESSION_BYTES"),
				...optionalPlain("MAPLE_INTERNAL_ORG_ID"),
				...optionalPlain("AUTUMN_API_URL"),
				...optionalPlain("COMMIT_SHA", process.env.GITHUB_SHA?.trim()),
			},

			tags: { Service: "maple-ingest", Region: region },
		})

		return {
			serviceUrl: service.url,
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
