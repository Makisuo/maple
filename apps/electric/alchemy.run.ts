import { resolve } from "node:path"
import * as AWS from "alchemy/AWS"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import type { MapleRegion } from "@maple/infra/aws"
import {
	ELECTRIC_REPLICATION_STREAM_ID,
	resolveAwsRegion,
	resolveAwsResourceName,
	resolveElectricCidrBlock,
	resolveElectricTaskSize,
} from "@maple/infra/aws"
import type { MapleDomains, MapleStage } from "@maple/infra/cloudflare"
import { requiredPlain } from "@maple/infra/env"

/** Port Electric's HTTP API binds (`ELECTRIC_PORT`, whose own default is 3000). */
const ELECTRIC_PORT = 3000

/**
 * Absolute for the same reason the ingest stack's is: alchemy has flipped how a
 * relative `dockerfile` resolves between releases, and each flip broke a deploy.
 */
const DOCKERFILE = resolve("apps/electric/Dockerfile")

/**
 * Where Electric keeps its shape cache and replication cursor. Task-local
 * ephemeral storage, which dies with the task — see the service below for why
 * that is a considered choice and not an oversight.
 */
const STORAGE_DIR = "/var/lib/electric"

export interface CreateMapleElectricOptions {
	stage: MapleStage
	domains: MapleDomains
	/** Geographic instance. Every AWS resource here is scoped to it. */
	region: MapleRegion
}

/**
 * Self-hosted ElectricSQL (`electricsql/electric`) on ECS Fargate.
 *
 * Replaces Electric Cloud as the upstream behind the `apps/electric-sync`
 * Worker. Nothing was migrated to stand this up: Postgres is the source of
 * truth and Electric is a cache over its logical replication stream, so the
 * whole move is "run the container, point `ELECTRIC_URL` at it".
 *
 * Deliberately its OWN VPC/cluster/ALB rather than a tenant of the ingest
 * fleet's. Sharing would mean lifting `apps/ingest`'s network out into a
 * factory both call — a refactor of the busiest thing we run, to save one load
 * balancer. The two have nothing else in common: different traffic shape,
 * different scaling story, different blast radius.
 *
 * The service is PUBLIC because its only client — the sync Worker — runs at the
 * Cloudflare edge and cannot be given a private route into a VPC. What guards
 * it is `ELECTRIC_SECRET`, which Electric requires on every shape request
 * unless `ELECTRIC_INSECURE` is set; the sync worker appends it as the `secret`
 * query param exactly as it did for Electric Cloud's source secret.
 */
export const createMapleElectric = ({ stage, domains, region }: CreateMapleElectricOptions) =>
	Effect.gen(function* () {
		const taskSize = resolveElectricTaskSize(stage)
		const name = (base: string) => resolveAwsResourceName(base, stage, region)

		// Public subnets, public IPs, no NAT — the ingest fleet's reasoning applies
		// unchanged, and here the outbound traffic that would be NAT-billed is the
		// replication stream itself. The S3 gateway endpoint keeps the ECR image
		// pull (S3-backed) off the public path and is free.
		const network = yield* AWS.EC2.Network("electric-network", {
			cidrBlock: resolveElectricCidrBlock(region),
			availabilityZones: 2,
			nat: "none",
			gatewayEndpoints: ["s3"],
			tags: { Service: "maple-electric", Region: region },
		})

		// Two groups for the reason spelled out in `apps/ingest/alchemy.run.ts`:
		// `AWS.ECS.Service` applies `securityGroups` to BOTH the ALB and the tasks,
		// so the separation has to live in the rules. The internet reaches the
		// listener; ELECTRIC_PORT is reachable only from the ALB's group. That
		// second rule is what stops someone who finds a task's public IP from
		// talking to Electric over plaintext HTTP, around the certificate.
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
					cidrIpv4: "0.0.0.0/0",
					// Not narrowed to Cloudflare's published ranges even though the only
					// caller is a Worker: a Worker's subrequests egress from Cloudflare's
					// own infrastructure, and pinning a security group to a list that
					// Cloudflare rotates would turn a routine range change into a total
					// sync outage with no signal pointing here. `ELECTRIC_SECRET` is the
					// control that actually authorizes a request.
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
		// variables in plaintext, readable by anyone holding
		// `ecs:DescribeTaskDefinition`. Both of these are credentials.
		const secret = (id: string, value: string) =>
			AWS.SecretsManager.Secret(id, {
				name: `${name("electric")}/${id}`,
				secretString: Redacted.make(value),
				tags: { Service: "maple-electric", Region: region },
			})

		// The DIRECT connection (port 5432), never PSBouncer or Hyperdrive: logical
		// replication cannot run through a transaction pooler. The role must carry
		// the REPLICATION *attribute*, which Postgres never grants through role
		// membership — a role that merely belongs to a replication role is rejected
		// by Electric's database validation with a message that does not say so.
		const databaseUrl = yield* secret("database-url", yield* requiredPlain("MAPLE_PG_ELECTRIC_URL"))
		// The same value the electric-sync Worker holds — one secret, both ends of
		// the hop. Rotating it means redeploying both, in that order (worker last,
		// or in-flight shape requests 401 against the new one).
		const apiSecret = yield* secret("api-secret", yield* requiredPlain("ELECTRIC_SECRET"))

		const certificate = domains.electric
			? yield* AWS.ACM.Certificate("electric-cert", {
					domainName: domains.electric,
					validationMethod: "DNS",
					// An ALB can only use a certificate from its own region, and the ACM
					// resource otherwise defaults to us-east-1.
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
			// Graviton, as with the gateway: ~20% cheaper per vCPU-hour and the image
			// is published multi-arch (linux/arm64 is in the manifest list), so this
			// costs nothing. Note a mismatch here is not a build failure — the task
			// pulls, starts, and dies with `exec format error`.
			runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
			cpu: taskSize.cpu,
			memory: taskSize.memory,

			// A SINGLETON, and the deployment config is the load-bearing half of
			// that. Two tasks cannot share one Postgres replication slot: the second
			// to connect is refused with `replication slot is active`, so a rolling
			// deploy (the ECS default of 100%/200%) would start a replacement that
			// crash-loops until the old task finally goes away. 0%/100% means stop
			// the old task, then start the new one.
			//
			// The cost is an intentional ~60s window per deploy in which shape
			// requests fail. `/dashboards` degrades to its HTTP snapshot
			// (`SyncDegradedBanner`); the alerts lists have no such fallback and show
			// their retry state until the stream reconnects. That is the price of a
			// single-node sync engine, and it is why the image tag is pinned — this
			// service should redeploy on purpose, not incidentally.
			desiredCount: 1,
			deploymentConfiguration: { minimumHealthyPercent: 0, maximumPercent: 100 },

			vpcId: network.vpcId,
			subnets: network.publicSubnetIds,
			securityGroups: [albSecurityGroup.groupId, taskSecurityGroup.groupId],
			assignPublicIp: true,

			public: true,
			// The CONTAINER port. The listener port is separate and defaults to 443
			// once `certificateArn` is set, which is what a Cloudflare-proxied origin
			// needs — the proxy only fetches origins on its supported port list.
			port: ELECTRIC_PORT,
			healthCheckPath: "/v1/health",
			...(certificate ? { certificateArn: certificate.certificateArn } : undefined),
			// Covers the initial replication connect and, on a cold storage dir, the
			// first snapshot of the published tables — eight small control-plane
			// tables, so this is generous rather than tight.
			healthCheckGracePeriod: "120 seconds",

			logging: { retention: "30 days" },

			secrets: {
				DATABASE_URL: databaseUrl.secretArn,
				ELECTRIC_SECRET: apiSecret.secretArn,
			},

			env: {
				ELECTRIC_PORT: String(ELECTRIC_PORT),
				// The publication is owned by a Drizzle migration, not by Electric:
				// PlanetScale cannot reassign table ownership, so Electric can never be
				// the table owner it would need to be to manage publishing itself.
				// This is prod parity with the local docker service.
				ELECTRIC_MANUAL_TABLE_PUBLISHING: "true",
				// Names the publication AND the slot (`electric_publication_maple` /
				// `electric_slot_maple`) — see ELECTRIC_REPLICATION_STREAM_ID for why
				// this is not Electric's `default`, and why changing it later is not
				// free.
				ELECTRIC_REPLICATION_STREAM_ID: ELECTRIC_REPLICATION_STREAM_ID,
				// Ephemeral task storage, on purpose. Electric wants a fast persistent
				// disk, and losing this directory costs a re-snapshot of eight small
				// tables plus a `must-refetch` for connected clients — while the
				// alternatives are worse: alchemy's only volume sugar is EFS, which is
				// the networked filesystem Electric's own guidance warns against, and
				// an EBS-backed task pins the service to one AZ. Revisit if
				// re-snapshots ever become the thing that hurts — `investigations`
				// and `investigation_lens_runs` carry jsonb and are the two that
				// would show it first.
				ELECTRIC_STORAGE_DIR: STORAGE_DIR,
			} satisfies Record<string, string>,

			tags: { Service: "maple-electric", Region: region },
		})

		return {
			serviceUrl: service.url,
			// One-time manual DNS, surfaced from the deploy output rather than the
			// AWS console: the ACM validation CNAME, and a proxied CNAME for
			// `domains.electric` at the ALB. Both live in the Cloudflare `maple.dev`
			// zone, which this stack does not otherwise touch.
			certificateValidation: certificate?.domainValidationOptions,
		}
	})
