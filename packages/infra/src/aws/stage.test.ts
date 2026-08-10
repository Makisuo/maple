import { describe, expect, it } from "vitest"
import { parseMapleStage } from "../cloudflare/stage.ts"
import {
	parseMapleRegion,
	resolveAwsRegion,
	resolveAwsResourceName,
	resolveIngestCidrBlock,
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
