import { resolve } from "node:path"
import * as AWS from "alchemy/AWS"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import type { MapleRegion } from "@maple/infra/aws"
import { resolveAwsRegion, resolveAwsResourceName, resolveElectricTaskSize } from "@maple/infra/aws"
import type { MapleDomains, MapleStage } from "@maple/infra/cloudflare"
import { requiredPlain } from "@maple/infra/env"

/** Port Electric's HTTP API binds (`ELECTRIC_PORT`, whose own default is 3000). */
const ELECTRIC_PORT = 3000

/**
 * Absolute for the same reason the ingest stack's is: alchemy has flipped how a
 * relative `dockerfile` resolves between releases, and each flip broke a deploy.
 */
const DOCKERFILE = resolve("apps/electric/Dockerfile")

export interface CreateMapleElectricOptions {
	stage: MapleStage
	domains: MapleDomains
	/** Geographic instance. Every AWS resource here is scoped to it. */
	region: MapleRegion
	/**
	 * The ingest fleet's VPC — see `createMapleIngest`'s return for why this is
	 * shared rather than a second `AWS.EC2.Network`.
	 */
	network: Pick<AWS.EC2.Network, "vpcId" | "publicSubnetIds">
}

/**
 * Self-hosted ElectricSQL (`electricsql/electric`) on ECS Fargate — the upstream
 * behind the `apps/electric-sync` Worker.
 *
 * Runs in the ingest fleet's VPC with its OWN cluster, ALB, security groups and
 * certificate. The shared VPC is not an economy — it is forced: two
 * `AWS.EC2.Network`s in one stack fight over the internet gateway, and the
 * second one's create tries to detach the first's from a VPC full of public
 * IPs. The two services want the same network anyway.
 *
 * See `docs/electric-sync.md` for the runbook and the cutover.
 */
export const createMapleElectric = ({ stage, domains, region, network }: CreateMapleElectricOptions) =>
	Effect.gen(function* () {
		const taskSize = resolveElectricTaskSize(stage)
		const name = (base: string) => resolveAwsResourceName(base, stage, region)

		// Two groups because `AWS.ECS.Service` applies `securityGroups` to BOTH the
		// ALB and the tasks, so the split has to live in the rules: the internet
		// reaches the listener, and ELECTRIC_PORT only the ALB's group. Tasks carry
		// public IPs, so without that second rule a task's own address would serve
		// Electric over plaintext HTTP, around the certificate.
		const listenerPort = domains.electric ? 443 : 80
		const albSecurityGroup = yield* AWS.EC2.SecurityGroup("electric-alb-sg", {
			vpcId: network.vpcId,
			groupName: name("electric-alb"),
			description: `Maple ElectricSQL - public ${listenerPort === 443 ? "HTTPS" : "HTTP"} to the load balancer`,
			ingress: [
				{
					ipProtocol: "tcp",
					fromPort: listenerPort,
					toPort: listenerPort,
					// Not narrowed to Cloudflare's published ranges even though a Worker
					// is the only caller: those rotate, and a rotation would become a
					// total sync outage with nothing pointing here. ELECTRIC_SECRET is
					// the control that authorizes a request.
					cidrIpv4: "0.0.0.0/0",
					description: "Shape requests from the electric-sync Worker",
				},
			],
		})

		const taskSecurityGroup = yield* AWS.EC2.SecurityGroup("electric-sg", {
			vpcId: network.vpcId,
			groupName: name("electric"),
			description: "Maple ElectricSQL sync service",
			ingress: [
				{
					ipProtocol: "tcp",
					fromPort: ELECTRIC_PORT,
					toPort: ELECTRIC_PORT,
					referencedGroupId: albSecurityGroup.groupId,
					description: "ALB to task",
				},
			],
		})

		const cluster = yield* AWS.ECS.Cluster("electric-cluster", {
			clusterName: name("electric"),
			tags: { Service: "maple-electric", Region: region },
		})

		// Through Secrets Manager, not `env`: ECS stores task-definition environment
		// variables in plaintext, readable with `ecs:DescribeTaskDefinition`.
		const secret = (id: string, value: string) =>
			AWS.SecretsManager.Secret(id, {
				name: `${name("electric")}/${id}`,
				secretString: Redacted.make(value),
				tags: { Service: "maple-electric", Region: region },
			})

		// The DIRECT connection (5432), never PSBouncer or Hyperdrive — logical
		// replication cannot run through a transaction pooler. The role must carry
		// the REPLICATION *attribute*, which Postgres never grants through role
		// membership; Electric's database validation rejects one that lacks it with
		// a message that does not say so.
		const databaseUrl = yield* secret("database-url", yield* requiredPlain("MAPLE_PG_ELECTRIC_URL"))
		// The same value the electric-sync Worker holds — one secret, both ends of
		// the hop. Rotating it means redeploying this first, then the worker.
		const apiSecret = yield* secret("api-secret", yield* requiredPlain("ELECTRIC_SECRET"))

		// An ALB can only use a certificate from its own region, and ACM otherwise
		// defaults to us-east-1. Without `hostedZoneId` the provider does not block
		// on issuance, so a new stage's first deploy fails at the 443 listener with
		// this PENDING_VALIDATION; the deploy workflows recover by running
		// `scripts/acm-cert-validate.sh` and redeploying. A new certificate-bearing
		// service MUST be added to that call.
		const certificate = domains.electric
			? yield* AWS.ACM.Certificate("electric-cert", {
					domainName: domains.electric,
					validationMethod: "DNS",
					region: resolveAwsRegion(region),
					tags: { Service: "maple-electric", Region: region },
				})
			: undefined

		const service = yield* AWS.ECS.Service("electric", {
			cluster,
			serviceName: name("electric"),

			// Upstream's image, pinned, rebuilt into ECR — see the Dockerfile.
			context: "apps/electric",
			dockerfile: DOCKERFILE,
			// Graviton, as with the gateway: the image is published multi-arch, so
			// this is ~20% off per vCPU-hour for nothing. A mismatch here is not a
			// build failure — the task pulls, starts, and dies with `exec format
			// error`.
			runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
			cpu: taskSize.cpu,
			memory: taskSize.memory,

			// A SINGLETON, and the deployment config is the load-bearing half. Two
			// tasks cannot share a Postgres replication slot — the second is refused
			// with `replication slot is active` — so the ECS default of 100%/200%
			// would crash-loop every replacement. 0%/100% stops the old task first,
			// at the cost of a ~60s window per deploy in which shapes fail (see
			// docs/electric-sync.md). The circuit breaker bounds a bad image to that
			// window instead of leaving the service down until the deploy times out.
			desiredCount: 1,
			deploymentConfiguration: {
				minimumHealthyPercent: 0,
				maximumPercent: 100,
				deploymentCircuitBreaker: { enable: true, rollback: true },
			},

			vpcId: network.vpcId,
			subnets: network.publicSubnetIds,
			securityGroups: [albSecurityGroup.groupId, taskSecurityGroup.groupId],
			assignPublicIp: true,

			// Public because the only caller is a Worker at the Cloudflare edge, with
			// no private route into a VPC; ELECTRIC_SECRET is what guards it. `port`
			// is the CONTAINER port — the listener is separate and defaults to 443
			// once `certificateArn` is set, which is what a Cloudflare-proxied origin
			// needs.
			public: true,
			port: ELECTRIC_PORT,
			healthCheckPath: "/v1/health",
			...(certificate ? { certificateArn: certificate.certificateArn } : undefined),
			// Covers the replication connect and, on a cold task, the first snapshot
			// of the published tables.
			healthCheckGracePeriod: "120 seconds",

			logging: { retention: "30 days" },

			secrets: {
				DATABASE_URL: databaseUrl.secretArn,
				ELECTRIC_SECRET: apiSecret.secretArn,
			},

			env: {
				ELECTRIC_PORT: String(ELECTRIC_PORT),
				// The publication is owned by a Drizzle migration: PlanetScale cannot
				// reassign table ownership, so Electric can never be the owner it would
				// need to be to manage publishing itself. Prod parity with local docker.
				//
				// ELECTRIC_REPLICATION_STREAM_ID is left at Electric's `default`, which
				// resolves to `electric_publication_default` — the publication those
				// migrations already own and keep correct.
				ELECTRIC_MANUAL_TABLE_PUBLISHING: "true",
				// ELECTRIC_STORAGE_DIR is left at the image's default, on task-local
				// storage that dies with the task. Losing it costs a re-snapshot of
				// eight small tables plus a `must-refetch` for connected clients, and
				// the alternatives are worse: alchemy's only volume sugar is EFS, the
				// networked filesystem Electric's guidance warns against, and an
				// EBS-backed task pins the service to one AZ.
			} satisfies Record<string, string>,

			tags: { Service: "maple-electric", Region: region },
		})

		return {
			serviceUrl: service.url,
			// One-time manual DNS in the Cloudflare `maple.dev` zone, surfaced from
			// the deploy rather than the AWS console: the ACM validation CNAME, and a
			// proxied CNAME for `domains.electric` at the ALB.
			certificateValidation: certificate?.domainValidationOptions,
		}
	})
