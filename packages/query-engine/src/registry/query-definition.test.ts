import { describe, expect, it } from "vitest"
import { canonicalJSON } from "../canonical-json"
import {
	isTimeBucketQueryCachePolicy,
	queryDefinitionCacheIdentity,
	resolveQueryDefinitionCache,
} from "./query-definition"
import { logsTimeseries, type LogsTimeseriesInput } from "./logs"

const input = (overrides: Partial<LogsTimeseriesInput> = {}): LogsTimeseriesInput => ({
	startTime: "2026-01-01 00:00:00",
	endTime: "2026-01-01 01:00:00",
	bucketSeconds: 300,
	groupBy: ["service"],
	filters: { severity: "ERROR" },
	...overrides,
})

describe("queryDefinitionCacheIdentity", () => {
	it("lets overlapping timeseries windows share the same semantic bucket identity", () => {
		const policy = resolveQueryDefinitionCache(logsTimeseries, input(), 0)
		expect(isTimeBucketQueryCachePolicy(policy)).toBe(true)
		if (!isTimeBucketQueryCachePolicy(policy)) throw new Error("expected time-bucket policy")

		const first = input()
		const overlapping = input({
			startTime: "2026-01-01 00:30:00",
			endTime: "2026-01-01 01:30:00",
		})
		const firstIdentity = queryDefinitionCacheIdentity(logsTimeseries, first, policy.identity(first))
		const overlappingIdentity = queryDefinitionCacheIdentity(
			logsTimeseries,
			overlapping,
			policy.identity(overlapping),
		)

		expect(canonicalJSON(firstIdentity)).toBe(canonicalJSON(overlappingIdentity))
	})

	it("keeps genuinely different query plans apart", () => {
		const policy = resolveQueryDefinitionCache(logsTimeseries, input(), 0)
		if (!isTimeBucketQueryCachePolicy(policy)) throw new Error("expected time-bucket policy")

		const byService = input({ groupBy: ["service"] })
		const bySeverity = input({ groupBy: ["severity"] })
		expect(
			canonicalJSON(
				queryDefinitionCacheIdentity(logsTimeseries, byService, policy.identity(byService)),
			),
		).not.toBe(
			canonicalJSON(
				queryDefinitionCacheIdentity(logsTimeseries, bySeverity, policy.identity(bySeverity)),
			),
		)
	})
})
