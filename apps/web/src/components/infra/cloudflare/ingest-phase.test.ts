import { describe, expect, it } from "vitest"

import {
	CloudflareAnalyticsWorkersStatus,
	CloudflareAnalyticsZoneStatus,
	CloudflareIntegrationStatus,
	CloudflareServiceUsage,
	CloudflareUsageResponse,
} from "@maple/domain/http"

import { cloudflareIngestPhase } from "./ingest-phase"

const NOW = 1_800_000_000_000
const MINUTE = 60_000
const HOUR = 60 * MINUTE

const zone = (
	name: string,
	overrides: Partial<{ watermarkAt: number | null; backfillAt: number | null; enabled: boolean }> = {},
) =>
	new CloudflareAnalyticsZoneStatus({
		id: `zone-${name}`,
		name,
		enabled: overrides.enabled ?? true,
		lastSyncedAt: null,
		lastError: null,
		watermarkAt: overrides.watermarkAt ?? null,
		backfillAt: overrides.backfillAt ?? null,
	})

const status = (overrides: {
	zones?: ReadonlyArray<CloudflareAnalyticsZoneStatus>
	workers?: CloudflareAnalyticsWorkersStatus | null
	connectedAt?: number | null
}) =>
	new CloudflareIntegrationStatus({
		connected: true,
		accountId: "acct",
		accountName: "Acme",
		connectedByUserId: null,
		scope: "analytics.read",
		analyticsCapable: true,
		connectedAt: overrides.connectedAt ?? NOW - 2 * MINUTE,
		accounts: [],
		zones: overrides.zones ?? [],
		workers: overrides.workers ?? null,
	})

const usage = (services: ReadonlyArray<{ name: string; kind: "zone" | "worker"; requests: number }>) =>
	new CloudflareUsageResponse({
		windowStart: NOW - 24 * HOUR,
		windowEnd: NOW,
		bucketSeconds: 3600,
		totalRequests: services.reduce((sum, service) => sum + service.requests, 0),
		services: services.map(
			(service) =>
				new CloudflareServiceUsage({
					serviceName: `cloudflare/${service.name}`,
					kind: service.kind,
					displayName: service.name,
					totalRequests: service.requests,
					totalDatapoints: service.requests,
					lastDataAt: service.requests > 0 ? NOW - MINUTE : null,
					buckets: [],
				}),
		),
	})

describe("cloudflareIngestPhase", () => {
	it("reports discovery while the poller has no state rows yet", () => {
		expect(cloudflareIngestPhase(status({}), usage([]), NOW)).toEqual({ kind: "discovering" })
	})

	it("reports collecting once zones are known but nothing is queryable", () => {
		const result = cloudflareIngestPhase(status({ zones: [zone("acme.com")] }), usage([]), NOW)
		expect(result).toEqual({ kind: "collecting" })
	})

	// The distinction the whole feature exists for: a young silence is the cadence, an old one
	// is a fault, and only the second one should tell someone to go check their connection.
	it("calls a long silence stalled rather than collecting", () => {
		const result = cloudflareIngestPhase(
			status({ zones: [zone("acme.com")], connectedAt: NOW - 45 * MINUTE }),
			usage([]),
			NOW,
		)
		expect(result).toEqual({ kind: "stalled" })
	})

	it("stalls a connection that never discovered anything", () => {
		expect(cloudflareIngestPhase(status({ connectedAt: NOW - 45 * MINUTE }), usage([]), NOW)).toEqual({
			kind: "stalled",
		})
	})

	it("holds the poller's view while usage is unavailable", () => {
		const collecting = cloudflareIngestPhase(status({ zones: [zone("acme.com")] }), null, NOW)
		expect(collecting).toEqual({ kind: "collecting" })

		const live = cloudflareIngestPhase(
			status({ zones: [zone("acme.com", { watermarkAt: NOW - 11 * MINUTE })] }),
			null,
			NOW,
		)
		expect(live).toEqual({ kind: "live" })
	})

	it("reports partial coverage while some zones are still catching up", () => {
		const result = cloudflareIngestPhase(
			status({ zones: [zone("acme.com"), zone("quiet.com")] }),
			usage([{ name: "acme.com", kind: "zone", requests: 10 }]),
			NOW,
		)
		expect(result).toEqual({ kind: "partial", live: 1, total: 2 })
	})

	// Past the stall window a zone with no traffic is just quiet — nagging about it forever
	// would make the banner permanent furniture on any account with an idle domain.
	it("stops calling a long-quiet zone partial", () => {
		const result = cloudflareIngestPhase(
			status({
				zones: [zone("acme.com"), zone("quiet.com")],
				connectedAt: NOW - 45 * MINUTE,
			}),
			usage([{ name: "acme.com", kind: "zone", requests: 10 }]),
			NOW,
		)
		expect(result).toEqual({ kind: "live" })
	})

	it("ignores disabled zones when judging coverage", () => {
		const result = cloudflareIngestPhase(
			status({ zones: [zone("acme.com"), zone("off.com", { enabled: false })] }),
			usage([{ name: "acme.com", kind: "zone", requests: 10 }]),
			NOW,
		)
		expect(result).toEqual({ kind: "live" })
	})

	it("counts Workers data as live even with no zones reporting", () => {
		const workers = new CloudflareAnalyticsWorkersStatus({
			enabled: true,
			lastSyncedAt: NOW - MINUTE,
			lastError: null,
			watermarkAt: NOW - 11 * MINUTE,
			backfillAt: null,
		})
		const result = cloudflareIngestPhase(
			status({ workers }),
			usage([{ name: "api", kind: "worker", requests: 5 }]),
			NOW,
		)
		expect(result).toEqual({ kind: "live" })
	})

	it("reports backfill progress from the least caught-up zone", () => {
		const result = cloudflareIngestPhase(
			status({
				zones: [
					zone("acme.com", { backfillAt: NOW - 20 * HOUR }),
					zone("other.com", { backfillAt: NOW - 6 * HOUR }),
				],
			}),
			usage([
				{ name: "acme.com", kind: "zone", requests: 10 },
				{ name: "other.com", kind: "zone", requests: 10 },
			]),
			NOW,
		)
		// other.com has only walked back 6h, so 18 of the 24 hours are still missing from a
		// day-wide chart — the caught-up zone next to it must not round that away.
		expect(result).toEqual({ kind: "backfilling", progress: 6 / 24 })
	})

	it("stays in backfill while one zone lags a finished one", () => {
		const result = cloudflareIngestPhase(
			status({
				zones: [
					zone("done.com", { backfillAt: NOW - 24 * HOUR }),
					zone("lagging.com", { backfillAt: NOW - 3 * HOUR }),
				],
			}),
			usage([
				{ name: "done.com", kind: "zone", requests: 10 },
				{ name: "lagging.com", kind: "zone", requests: 10 },
			]),
			NOW,
		)
		expect(result).toEqual({ kind: "backfilling", progress: 3 / 24 })
	})

	it("treats a frontier within a poll window of the floor as finished", () => {
		const result = cloudflareIngestPhase(
			status({ zones: [zone("acme.com", { backfillAt: NOW - 23.5 * HOUR })] }),
			usage([{ name: "acme.com", kind: "zone", requests: 10 }]),
			NOW,
		)
		expect(result).toEqual({ kind: "live" })
	})
})
