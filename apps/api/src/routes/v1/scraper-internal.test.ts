import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { ScrapeResultReportList } from "@maple/domain/http"
import { isValidInternalBearer } from "@/services/auth/internal-auth"
import { toInternalScrapeTarget } from "./scraper-internal.http"

describe("internal bearer auth", () => {
	it("validates internal bearer tokens with exact match", () => {
		assert.isTrue(isValidInternalBearer("Bearer secret-token", "secret-token"))
		assert.isFalse(isValidInternalBearer("Bearer wrong", "secret-token"))
		assert.isFalse(isValidInternalBearer(undefined, "secret-token"))
		assert.isFalse(isValidInternalBearer("Bearer secret-token", undefined))
		assert.isFalse(isValidInternalBearer("secret-token", "secret-token"))
	})
})

describe("toInternalScrapeTarget", () => {
	const baseRow = {
		id: "11111111-1111-4111-8111-111111111111",
		orgId: "org_1",
		name: "Node Exporter",
		serviceName: "node",
		url: "https://node.example.com:9100/metrics",
		scrapeIntervalSeconds: 15,
		labelsJson: { env: "prod" },
	}

	const INGEST_KEY = "maple_pk_test_key"

	it.effect("marshals a row with parsed labels and the org's ingest key", () =>
		Effect.gen(function* () {
			const result = yield* toInternalScrapeTarget(baseRow, INGEST_KEY)
			assert.isTrue(Option.isSome(result))
			if (Option.isNone(result)) return
			assert.strictEqual(result.value.id, baseRow.id)
			assert.strictEqual(result.value.orgId, "org_1")
			assert.strictEqual(result.value.serviceName, "node")
			assert.strictEqual(result.value.scrapeIntervalSeconds, 15)
			assert.deepStrictEqual(result.value.labels, { env: "prod" })
			assert.strictEqual(result.value.ingestKey, INGEST_KEY)
		}),
	)

	it.effect("degrades invalid labelsJson to an empty record", () =>
		Effect.gen(function* () {
			// jsonb drift: the column should hold Record<string, string>, but a row
			// written by an older deploy (or by hand) may not — the decode guard must
			// degrade it to {} instead of failing the list.
			const driftedLabels = { env: 123 }
			const result = yield* toInternalScrapeTarget(
				{ ...baseRow, labelsJson: driftedLabels },
				INGEST_KEY,
			)
			assert.isTrue(Option.isSome(result))
			if (Option.isNone(result)) return
			assert.deepStrictEqual(result.value.labels, {})
		}),
	)

	it.effect("handles null labelsJson and null serviceName", () =>
		Effect.gen(function* () {
			const result = yield* toInternalScrapeTarget(
				{ ...baseRow, labelsJson: null, serviceName: null },
				INGEST_KEY,
			)
			assert.isTrue(Option.isSome(result))
			if (Option.isNone(result)) return
			assert.deepStrictEqual(result.value.labels, {})
			assert.isNull(result.value.serviceName)
		}),
	)

	it.effect("drops rows that violate the schema brands instead of failing the list", () =>
		Effect.gen(function* () {
			const outOfRange = yield* toInternalScrapeTarget(
				{ ...baseRow, scrapeIntervalSeconds: 2 },
				INGEST_KEY,
			)
			assert.isTrue(Option.isNone(outOfRange))
		}),
	)

	it.effect("expands a discovered sub-target with its url, key, and merged labels", () =>
		Effect.gen(function* () {
			const result = yield* toInternalScrapeTarget(baseRow, INGEST_KEY, {
				url: "https://branch-1.metrics.psdb.cloud/metrics",
				subTargetKey: "branch-1",
				labels: { planetscale_database_branch_id: "branch-1", env: "discovery" },
			})
			assert.isTrue(Option.isSome(result))
			if (Option.isNone(result)) return
			assert.strictEqual(result.value.id, baseRow.id)
			assert.strictEqual(result.value.url, "https://branch-1.metrics.psdb.cloud/metrics")
			assert.strictEqual(result.value.subTargetKey, "branch-1")
			// The target's own labelsJson wins over discovery labels on conflicts.
			assert.deepStrictEqual(result.value.labels, {
				planetscale_database_branch_id: "branch-1",
				env: "prod",
			})
		}),
	)

	it.effect("defaults subTargetKey to null for plain targets", () =>
		Effect.gen(function* () {
			const result = yield* toInternalScrapeTarget(baseRow, INGEST_KEY)
			assert.isTrue(Option.isSome(result))
			if (Option.isNone(result)) return
			assert.isNull(result.value.subTargetKey)
		}),
	)
})

describe("ScrapeResultReportList decoding", () => {
	const decode = Schema.decodeUnknownSync(ScrapeResultReportList)

	it("accepts reports with check metadata", () => {
		const reports = decode([
			{
				targetId: "11111111-1111-4111-8111-111111111111",
				scrapedAt: 1750000000000,
				error: null,
				subTargetKey: "branch-1",
				durationMs: 250,
				samplesScraped: 120,
				samplesPostMetricRelabeling: 118,
			},
		])
		assert.strictEqual(reports[0]?.durationMs, 250)
		assert.strictEqual(reports[0]?.samplesScraped, 120)
		assert.strictEqual(reports[0]?.samplesPostMetricRelabeling, 118)
	})

	it("accepts legacy reports without check metadata (older scraper deploys)", () => {
		const reports = decode([
			{
				targetId: "11111111-1111-4111-8111-111111111111",
				scrapedAt: 1750000000000,
				error: "target returned HTTP 503",
			},
		])
		assert.strictEqual(reports[0]?.error, "target returned HTTP 503")
		assert.strictEqual(reports[0]?.durationMs, undefined)
	})
})
