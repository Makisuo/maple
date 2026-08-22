import { describe, expect, it } from "vitest"
import { parseMapleStage } from "../cloudflare/stage.ts"
import {
	parseMapleRegion,
	resolveAwsRegion,
	resolveAwsResourceName,
	resolveCollectorEndpoint,
	resolveCollectorTaskSize,
	resolveIngestCidrBlock,
	resolveIngestNamespaceName,
	stageDeploysCollector,
	stageDeploysIngest,
} from "./stage.ts"

describe("parseMapleRegion", () => {
	it("defaults to us when unset", () => {
		expect(parseMapleRegion(undefined)).toBe("us")
		expect(parseMapleRegion("")).toBe("us")
		expect(parseMapleRegion("  ")).toBe("us")
	})

	it("accepts either region, case-insensitively", () => {
		expect(parseMapleRegion("EU")).toBe("eu")
		expect(parseMapleRegion(" us ")).toBe("us")
	})

	it("rejects anything else rather than silently defaulting", () => {
		expect(() => parseMapleRegion("apac")).toThrow(/Unsupported Maple region/)
	})
})

describe("resolveAwsResourceName", () => {
	it("leaves us unsuffixed so adding eu renames nothing", () => {
		expect(resolveAwsResourceName("ingest", parseMapleStage("prd"), "us")).toBe("maple-ingest")
		expect(resolveAwsResourceName("ingest", parseMapleStage("stg"), "us")).toBe("maple-ingest-stg")
	})

	it("defaults to us when no region is passed", () => {
		expect(resolveAwsResourceName("ingest", parseMapleStage("prd"))).toBe("maple-ingest")
	})

	it("suffixes eu, keeping the two instances distinct at every stage", () => {
		expect(resolveAwsResourceName("ingest", parseMapleStage("prd"), "eu")).toBe("maple-ingest-eu")
		expect(resolveAwsResourceName("ingest", parseMapleStage("stg"), "eu")).toBe("maple-ingest-eu-stg")
	})
})

describe("region topology", () => {
	it("maps each region to a distinct AWS region and a non-overlapping CIDR", () => {
		expect(resolveAwsRegion("us")).toBe("us-east-1")
		expect(resolveAwsRegion("eu")).toBe("eu-central-1")
		expect(resolveIngestCidrBlock("us")).not.toBe(resolveIngestCidrBlock("eu"))
	})
})

describe("collector service discovery", () => {
	it("puts the collector in a per-stage namespace the gateway can name at plan time", () => {
		expect(resolveIngestNamespaceName(parseMapleStage("prd"))).toBe("maple-ingest.internal")
		expect(resolveIngestNamespaceName(parseMapleStage("stg"))).toBe("maple-ingest-stg.internal")
		expect(resolveIngestNamespaceName(parseMapleStage("pr-12"))).toBe("maple-ingest-pr-12.internal")
		expect(resolveIngestNamespaceName(parseMapleStage("prd"), "eu")).toBe("maple-ingest-eu.internal")
	})

	it("derives the gateway's forward endpoint from the same names", () => {
		expect(resolveCollectorEndpoint(parseMapleStage("prd"))).toBe(
			"http://otel-collector.maple-ingest.internal:4318",
		)
		expect(resolveCollectorEndpoint(parseMapleStage("pr-12"), "eu")).toBe(
			"http://otel-collector.maple-ingest-eu-pr-12.internal:4318",
		)
	})

	it("deploys the collector to prd only for now, a subset of the gateway stages", () => {
		expect(stageDeploysCollector(parseMapleStage("prd"))).toBe(true)
		expect(stageDeploysCollector(parseMapleStage("stg"))).toBe(false)
		expect(stageDeploysCollector(parseMapleStage("pr-12"))).toBe(false)
		for (const stage of ["prd", "stg", "pr-12", "dev-alice"]) {
			if (stageDeploysCollector(parseMapleStage(stage))) {
				expect(stageDeploysIngest(parseMapleStage(stage))).toBe(true)
			}
		}
	})

	it("sizes the collector task with 1 GiB everywhere so the memory limiter can fire", () => {
		expect(resolveCollectorTaskSize(parseMapleStage("prd"))).toEqual({ cpu: 512, memory: 1024 })
		expect(resolveCollectorTaskSize(parseMapleStage("stg"))).toEqual({ cpu: 256, memory: 1024 })
		expect(resolveCollectorTaskSize(parseMapleStage("pr-12"))).toEqual({ cpu: 256, memory: 1024 })
	})
})
