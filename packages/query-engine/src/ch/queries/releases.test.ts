import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/clickhouse-builder"
import { releaseErrorFingerprintsQuery, releasesListQuery, releasesTimelineQuery } from "./releases"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
}

describe("releasesListQuery", () => {
	it("groups the service-window splice by service, environment and commit", () => {
		const { sql } = compileUnsafe(
			releasesListQuery({ environments: ["production"], serviceNames: ["api", "web"] }),
			baseParams,
		)
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).toContain("FROM service_overview_hourly")
		expect(sql).toContain("UNION ALL")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("DeploymentEnv IN ('production')")
		expect(sql).toContain("bServiceName IN ('api', 'web')")
		expect(sql).toContain("bCommitSha NOT IN ('', 'unknown', 'N/A')")
		expect(sql).toContain("GROUP BY serviceName, environment, commitSha")
		expect(sql).toContain("quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles)")
		expect(sql).toContain("ORDER BY firstSeen DESC, spanCount DESC")
		expect(sql).toContain("LIMIT 500")
	})

	it("scopes to one service for the detail comparison", () => {
		const { sql } = compileUnsafe(releasesListQuery({ serviceName: "api", limit: 50 }), baseParams)
		expect(sql).toContain("ServiceName = 'api'")
		expect(sql).toContain("LIMIT 50")
	})
})

describe("releasesTimelineQuery", () => {
	it("reads the rollup tiers for whole-minute buckets", () => {
		const { sql } = compileUnsafe(releasesTimelineQuery({ bucketSeconds: 300 }), {
			...baseParams,
			bucketSeconds: 300,
		})
		expect(sql).toContain("FROM service_overview_minutely")
		expect(sql).not.toContain("FROM service_overview_hourly")
		expect(sql).toContain("toStartOfInterval(bBucket, INTERVAL 300 SECOND)")
		expect(sql).toContain("GROUP BY bucket, serviceName, commitSha")
	})

	it("adds the hourly tier for whole-hour buckets", () => {
		const { sql } = compileUnsafe(releasesTimelineQuery({ bucketSeconds: 3600 }), {
			...baseParams,
			bucketSeconds: 3600,
		})
		expect(sql).toContain("FROM service_overview_hourly")
	})

	it("falls back to the entry-point projection for sub-minute buckets", () => {
		const { sql } = compileUnsafe(releasesTimelineQuery({ bucketSeconds: 30, serviceNames: ["api"] }), {
			...baseParams,
			bucketSeconds: 30,
		})
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).not.toContain("UNION ALL")
		expect(sql).toContain("ServiceName = 'api'")
		expect(sql).toContain("CommitSha NOT IN ('', 'unknown', 'N/A')")
	})
})

describe("releaseErrorFingerprintsQuery", () => {
	it("keys on the version string and stringifies the hash", () => {
		const { sql } = compileUnsafe(
			releaseErrorFingerprintsQuery({ serviceName: "api", environments: ["production"] }),
			{ ...baseParams, serviceVersion: "abc123" },
		)
		expect(sql).toContain("FROM error_events_by_time")
		expect(sql).toContain("toString(FingerprintHash)")
		expect(sql).toContain("ServiceName = 'api'")
		expect(sql).toContain("ServiceVersion = 'abc123'")
		expect(sql).toContain("DeploymentEnv IN ('production')")
		expect(sql).toContain("GROUP BY fingerprintHash")
		expect(sql).toContain("LIMIT 50")
	})
})
