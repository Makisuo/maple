import type { MapleStage } from "../cloudflare/stage.ts"

/**
 * Geographic instance a deployment belongs to.
 *
 * Orthogonal to `MapleStage`: stage is prd/stg/pr/dev, region is which
 * geographic instance. A full EU instance is `region: "eu"` at every stage,
 * with its OWN Tinybird workspace, application database, and ingest fleet —
 * telemetry that lands in `eu` must never transit `us`, which is the whole
 * point of having one.
 *
 * `us` is deliberately the unsuffixed default so adding `eu` later renames
 * nothing (a rename destroys and recreates every resource).
 */
export type MapleRegion = "us" | "eu"

export const DEFAULT_MAPLE_REGION: MapleRegion = "us"

export function parseMapleRegion(value: string | undefined): MapleRegion {
	const normalized = value?.trim().toLowerCase()
	if (!normalized) {
		return DEFAULT_MAPLE_REGION
	}
	if (normalized === "us" || normalized === "eu") {
		return normalized
	}
	throw new Error(`Unsupported Maple region "${value}". Expected "us" or "eu".`)
}

/**
 * AWS region backing each Maple region.
 *
 * This MUST match the region of the Tinybird workspace the instance exports to.
 * AWS bills $0.09/GB to the public internet but only $0.01/GB to a public IP in
 * the SAME region, and the gateway's export traffic dwarfs every other line
 * item — at 200k req/s that difference is ~$83k/mo vs ~$16k/mo. Tinybird's AWS
 * regions are us-east-1, us-west-2, eu-central-1, eu-west-1, ap-east-1,
 * ap-southeast-2; a workspace on `https://api.tinybird.co` is GCP Frankfurt, in
 * which case NO AWS region colocates and the move costs more than Railway.
 *
 * Verify the instance's TINYBIRD_HOST before changing a mapping.
 */
export function resolveAwsRegion(region: MapleRegion): string {
	switch (region) {
		case "us":
			return "us-east-1"
		case "eu":
			return "eu-central-1"
	}
}

/**
 * VPC CIDR per Maple region, kept non-overlapping so two instances can be
 * peered later without renumbering. Nothing peers them today.
 */
export function resolveIngestCidrBlock(region: MapleRegion): string {
	switch (region) {
		case "us":
			return "10.20.0.0/16"
		case "eu":
			return "10.21.0.0/16"
	}
}

/**
 * Physical name for an AWS resource, mirroring `resolveWorkerName` so both
 * clouds read the same in a console. Kept as a separate function rather than
 * reusing the Cloudflare one because AWS name constraints differ per service
 * (ECS names allow `[a-zA-Z0-9-_]`, but ALB names cap at 32 chars).
 *
 * `us` carries no region suffix — see `MapleRegion`.
 */
export function resolveAwsResourceName(
	base: string,
	stage: MapleStage,
	region: MapleRegion = DEFAULT_MAPLE_REGION,
): string {
	const suffix = region === DEFAULT_MAPLE_REGION ? "" : `-${region}`
	switch (stage.kind) {
		case "prd":
			return `maple-${base}${suffix}`
		case "stg":
			return `maple-${base}${suffix}-stg`
		case "pr":
			return `maple-${base}${suffix}-pr-${stage.prNumber}`
		case "dev":
			return `maple-${base}${suffix}-dev-${stage.name}`
	}
}

/**
 * Desired ECS task count per stage.
 *
 * prd runs 2 for availability across AZs; everything else runs 1. Note the
 * per-org replay byte budget in the gateway is process-local
 * (`apps/ingest/src/main.rs`), so the effective ceiling is roughly N x the
 * configured limit — raising this raises that ceiling too.
 */
export function resolveIngestDesiredCount(stage: MapleStage): number {
	return stage.kind === "prd" ? 2 : 1
}

export interface IngestTaskSize {
	/** Fargate CPU units. 1024 = 1 vCPU. */
	cpu: number
	/** Fargate memory in MiB. Must be a legal pairing with `cpu`. */
	memory: number
}

/**
 * Fargate task size per stage.
 *
 * Sized from ~1,300 req/s per vCPU — gzip level 6 on the export path
 * (`apps/ingest/src/telemetry.rs`) is the binding constraint, not protobuf
 * decode. prd gets 1 vCPU x 2 tasks, which carries today's ~500 req/s with
 * roughly 4x headroom for bursts.
 */
export function resolveIngestTaskSize(stage: MapleStage): IngestTaskSize {
	return stage.kind === "prd" ? { cpu: 1024, memory: 2048 } : { cpu: 512, memory: 1024 }
}

/**
 * Whether a stage gets an AWS ingest deployment at all.
 *
 * PR previews are excluded deliberately: `resolveMapleDomains` gives them no
 * `ingest` domain, and a VPC + ALB per PR is real money for a stack nothing
 * points at. Dev stages run the gateway through docker-compose instead.
 */
export function stageDeploysIngest(stage: MapleStage): boolean {
	return stage.kind === "prd" || stage.kind === "stg"
}
