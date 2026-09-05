import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { CommitSha, ServiceName } from "@maple/domain/http"
import type { Release, ReleaseTimelineBucket } from "@/api/warehouse/releases"
import {
	deriveReleaseImpacts,
	groupReleases,
	lastBucketShares,
	releaseDayLabel,
	releaseFacetCounts,
	shortReleaseLabel,
} from "./release-model"

const sha = Schema.decodeUnknownSync(CommitSha)
const svc = Schema.decodeUnknownSync(ServiceName)
const SHA_A = sha("a".repeat(40))
const SHA_B = sha("b".repeat(40))
const API = svc("api")
const WEB = svc("web")

function release(overrides: Partial<Release> & Pick<Release, "commitSha" | "serviceName">): Release {
	return {
		environment: "production",
		firstSeen: "2026-09-05T09:00:00.000Z",
		lastSeen: "2026-09-05T12:00:00.000Z",
		spanCount: 1000,
		estimatedSpanCount: 1000,
		errorCount: 3,
		estimatedErrorCount: 3,
		p50LatencyMs: 90,
		p95LatencyMs: 400,
		p99LatencyMs: 1200,
		apdexScore: 0.95,
		...overrides,
	}
}

function bucket(
	iso: string,
	serviceName: ServiceName,
	commitSha: CommitSha,
	count: number,
): ReleaseTimelineBucket {
	return { bucket: iso, serviceName, commitSha, count, errorCount: 0 }
}

describe("deriveReleaseImpacts", () => {
	it("flags a version that errors twice as often as the rest of its service", () => {
		const rows = [
			release({
				commitSha: SHA_B,
				serviceName: API,
				firstSeen: "2026-09-05T10:00:00.000Z",
				errorCount: 40,
			}),
			release({ commitSha: SHA_A, serviceName: API, errorCount: 3 }),
		]
		const [newer, older] = deriveReleaseImpacts(rows, [])
		expect(newer?.health).toBe("regressed")
		expect(newer?.errorRatio).toBeCloseTo(40 / 3, 3)
		expect(newer?.isNewest).toBe(true)
		expect(older?.health).toBe("healthy")
		expect(older?.baseline?.versions).toBe(1)
	})

	it("withholds the comparison below the span floor", () => {
		const rows = [
			release({ commitSha: SHA_B, serviceName: API, spanCount: 20, errorCount: 10 }),
			release({ commitSha: SHA_A, serviceName: API, firstSeen: "2026-09-04T09:00:00.000Z" }),
		]
		const [newer] = deriveReleaseImpacts(rows, [])
		expect(newer?.errorRatio).toBeUndefined()
		expect(newer?.health).toBe("healthy")
	})

	it("calls a latency jump a watch, not a regression", () => {
		const rows = [
			release({
				commitSha: SHA_B,
				serviceName: API,
				firstSeen: "2026-09-05T10:00:00.000Z",
				p95LatencyMs: 600,
			}),
			release({ commitSha: SHA_A, serviceName: API }),
		]
		const [newer] = deriveReleaseImpacts(rows, [])
		expect(newer?.p95Delta).toBeCloseTo(0.5, 3)
		expect(newer?.health).toBe("watch")
	})

	it("reads a partial share of the last bucket as rolling out", () => {
		const rows = [
			release({ commitSha: SHA_B, serviceName: API, firstSeen: "2026-09-05T11:00:00.000Z" }),
			release({ commitSha: SHA_A, serviceName: API }),
		]
		const timeline = [
			bucket("2026-09-05T11:00:00.000Z", API, SHA_A, 60),
			bucket("2026-09-05T11:00:00.000Z", API, SHA_B, 40),
		]
		const [newer, older] = deriveReleaseImpacts(rows, timeline)
		expect(newer?.share).toBeCloseTo(0.4, 3)
		expect(newer?.health).toBe("rolling")
		expect(older?.health).toBe("healthy")
	})

	it("does not call a dozen spans a rollout", () => {
		const rows = [
			release({
				commitSha: SHA_B,
				serviceName: API,
				firstSeen: "2026-09-05T11:00:00.000Z",
				spanCount: 13,
			}),
			release({ commitSha: SHA_A, serviceName: API }),
		]
		const timeline = [
			bucket("2026-09-05T11:00:00.000Z", API, SHA_A, 990),
			bucket("2026-09-05T11:00:00.000Z", API, SHA_B, 10),
		]
		const [newer] = deriveReleaseImpacts(rows, timeline)
		expect(newer?.share).toBeCloseTo(0.01, 3)
		expect(newer?.health).toBe("healthy")
	})

	it("has no baseline for the only version of a service", () => {
		const [only] = deriveReleaseImpacts([release({ commitSha: SHA_A, serviceName: API })], [])
		expect(only?.baseline).toBeUndefined()
		expect(only?.health).toBe("healthy")
	})

	it("keeps environments apart", () => {
		const rows = [
			release({ commitSha: SHA_A, serviceName: API, environment: "production" }),
			release({ commitSha: SHA_A, serviceName: API, environment: "staging", errorCount: 500 }),
		]
		const impacts = deriveReleaseImpacts(rows, [])
		expect(impacts.every((impact) => impact.baseline === undefined)).toBe(true)
	})
})

describe("lastBucketShares", () => {
	it("reads 0 for a version absent from the service's last bucket", () => {
		const timeline = [
			bucket("2026-09-05T10:00:00.000Z", API, SHA_A, 10),
			bucket("2026-09-05T11:00:00.000Z", API, SHA_B, 10),
		]
		const shares = lastBucketShares(timeline)
		expect(shares.get(`api ${SHA_A}`)).toBe(0)
		expect(shares.get(`api ${SHA_B}`)).toBe(1)
	})
})

describe("groupReleases", () => {
	it("folds one sha across services, newest first, worst health wins", () => {
		const rows = [
			release({ commitSha: SHA_A, serviceName: WEB, firstSeen: "2026-09-05T09:05:00.000Z" }),
			release({
				commitSha: SHA_A,
				serviceName: API,
				errorCount: 100,
				firstSeen: "2026-09-05T09:00:00.000Z",
			}),
			release({ commitSha: SHA_B, serviceName: API, firstSeen: "2026-09-04T09:00:00.000Z" }),
		]
		const groups = groupReleases(deriveReleaseImpacts(rows, []))
		expect(groups.map((g) => g.commitSha)).toEqual([SHA_A, SHA_B])
		expect(groups[0]?.services.map((s) => s.serviceName)).toEqual(["web", "api"])
		expect(groups[0]?.firstSeen).toBe("2026-09-05T09:00:00.000Z")
		expect(groups[0]?.health).toBe("regressed")
		expect(groups[0]?.spanCount).toBe(2000)
	})
})

describe("releaseFacetCounts", () => {
	it("counts groups by health and services by appearance", () => {
		const rows = [
			release({ commitSha: SHA_A, serviceName: WEB }),
			release({ commitSha: SHA_A, serviceName: API, environment: "" }),
			release({ commitSha: SHA_B, serviceName: API, firstSeen: "2026-09-04T09:00:00.000Z" }),
		]
		const counts = releaseFacetCounts(groupReleases(deriveReleaseImpacts(rows, [])))
		expect(counts.health.healthy).toBe(2)
		expect(counts.services).toEqual([
			{ name: "api", count: 2 },
			{ name: "web", count: 1 },
		])
		expect(counts.environments.map((e) => e.name)).toEqual(["production", "unknown"])
	})
})

describe("labels", () => {
	it("shortens only full git shas", () => {
		expect(shortReleaseLabel(SHA_A)).toBe("aaaaaaa")
		expect(shortReleaseLabel("v0.41.2")).toBe("v0.41.2")
	})

	it("names today and yesterday", () => {
		const now = new Date("2026-09-05T15:00:00").getTime()
		expect(releaseDayLabel(new Date("2026-09-05T09:00:00").toISOString(), now)).toBe("Today")
		expect(releaseDayLabel(new Date("2026-09-04T23:30:00").toISOString(), now)).toBe("Yesterday")
		expect(releaseDayLabel("not a date", now)).toBe("not a date")
	})
})
