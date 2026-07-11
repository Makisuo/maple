import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { CreateScrapeTargetRequest, OrgId, ScrapeIntervalSeconds, ScrapeTargetId } from "@maple/domain/http"
import { Env } from "../lib/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "../lib/test-pglite"
import { PlanetScaleDiscoveryService } from "./PlanetScaleDiscoveryService"
import { PlanetScaleOAuthService } from "./PlanetScaleOAuthService"
import { ScrapeTargetsService } from "./ScrapeTargetsService"

const trackedDbs: TestDb[] = []
const originalFetch = globalThis.fetch

// create() forks a detached probe that uses the global fetch; stub it before
// EVERY test (afterEach restores the real fetch, so a module-level stub would
// only protect the first test) so the tests never touch the real network.
beforeEach(() => {
	globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch
})

afterEach(async () => {
	globalThis.fetch = originalFetch
	await cleanupTestDbs(trackedDbs)
})

const makeConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			MCP_PORT: "3473",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

const makeLayer = (testDb: TestDb) => {
	const oauthLive = PlanetScaleOAuthService.layer
	return ScrapeTargetsService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(PlanetScaleDiscoveryService.layer.pipe(Layer.provide(oauthLive)), oauthLive),
		),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig()),
	)
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asScrapeIntervalSeconds = Schema.decodeUnknownSync(ScrapeIntervalSeconds)

describe("ScrapeTargetsService", () => {
	it.effect("scrapeForCollector applies stored bearer credentials", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<{ url: string; authorization: string | null }> = []

		globalThis.fetch = (async (input, init) => {
			const requestUrl =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
			const headers = new Headers(init?.headers)
			calls.push({
				url: requestUrl,
				authorization: headers.get("authorization"),
			})
			return new Response("up 1\n", {
				status: 200,
				headers: { "content-type": "text/plain; version=0.0.4" },
			})
		}) as typeof fetch

		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const target = yield* service.create(
				asOrgId("org_1"),
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
					authType: "bearer",
					authCredentials: JSON.stringify({ token: "stored-token" }),
				}),
			)

			const response = yield* service.scrapeForCollector(target.id)

			assert.strictEqual(response.status, 200)
			assert.strictEqual(response.body, "up 1\n")
			assert.strictEqual(response.contentType, "text/plain; version=0.0.4")
			assert.isTrue(calls.some((call) => call.url === "https://metrics.example.com/metrics"))
			assert.isTrue(calls.every((call) => call.authorization === "Bearer stored-token"))
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("recordScrapeResults updates lastScrapeAt on success and clears the error", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			const target = yield* service.create(
				orgId,
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
				}),
			)

			const scrapedAt = 1750000000000
			yield* service.recordScrapeResults([{ targetId: target.id, scrapedAt, error: null }])

			const updated = yield* service.get(orgId, target.id)
			assert.strictEqual(updated.lastScrapeAt, new Date(scrapedAt).toISOString())
			assert.isNull(updated.lastScrapeError)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("recordScrapeResults keeps lastScrapeAt at the last good scrape on failure", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			const target = yield* service.create(
				orgId,
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
				}),
			)

			const goodScrapeAt = 1750000000000
			yield* service.recordScrapeResults([
				{ targetId: target.id, scrapedAt: goodScrapeAt, error: null },
			])
			yield* service.recordScrapeResults([
				{ targetId: target.id, scrapedAt: goodScrapeAt + 15_000, error: "HTTP 503" },
			])

			const updated = yield* service.get(orgId, target.id)
			assert.strictEqual(updated.lastScrapeAt, new Date(goodScrapeAt).toISOString())
			assert.strictEqual(updated.lastScrapeError, "HTTP 503")

			// A later success clears the error again.
			yield* service.recordScrapeResults([
				{ targetId: target.id, scrapedAt: goodScrapeAt + 30_000, error: null },
			])
			const recovered = yield* service.get(orgId, target.id)
			assert.strictEqual(recovered.lastScrapeAt, new Date(goodScrapeAt + 30_000).toISOString())
			assert.isNull(recovered.lastScrapeError)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("recordScrapeResults tolerates unknown target ids and processes batches", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			const target = yield* service.create(
				orgId,
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
				}),
			)

			const unknownId = Schema.decodeUnknownSync(ScrapeTargetId)("99999999-9999-4999-8999-999999999999")
			const scrapedAt = 1750000000000
			yield* service.recordScrapeResults([
				{ targetId: unknownId, scrapedAt, error: null },
				{ targetId: target.id, scrapedAt, error: null },
			])

			const updated = yield* service.get(orgId, target.id)
			assert.strictEqual(updated.lastScrapeAt, new Date(scrapedAt).toISOString())
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("creates a PlanetScale target with a derived discovery URL and forced token auth", () => {
		const testDb = createTestDb(trackedDbs)
		globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const target = yield* service.create(
				asOrgId("org_1"),
				new CreateScrapeTargetRequest({
					name: "PlanetScale Prod",
					targetType: "planetscale",
					organization: "my-org",
					authCredentials: JSON.stringify({ tokenId: "tok_id", tokenSecret: "tok_secret" }),
				}),
			)

			assert.strictEqual(target.targetType, "planetscale")
			assert.strictEqual(target.organization, "my-org")
			assert.strictEqual(target.url, "https://api.planetscale.com/v1/organizations/my-org/metrics")
			assert.strictEqual(target.authType, "token")
			assert.isTrue(target.hasCredentials)
			// PlanetScale's documented default scrape interval.
			assert.strictEqual(target.scrapeIntervalSeconds, 30)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("rejects invalid PlanetScale create requests", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")

			const missingOrg = yield* service
				.create(
					orgId,
					new CreateScrapeTargetRequest({
						name: "PS",
						targetType: "planetscale",
						authCredentials: JSON.stringify({ tokenId: "a", tokenSecret: "b" }),
					}),
				)
				.pipe(Effect.flip)
			assert.include(missingOrg.message, "organization is required")

			const withUrl = yield* service
				.create(
					orgId,
					new CreateScrapeTargetRequest({
						name: "PS",
						targetType: "planetscale",
						organization: "my-org",
						url: "https://example.com/metrics",
						authCredentials: JSON.stringify({ tokenId: "a", tokenSecret: "b" }),
					}),
				)
				.pipe(Effect.flip)
			assert.include(withUrl.message, "do not provide a url")

			const badCredentials = yield* service
				.create(
					orgId,
					new CreateScrapeTargetRequest({
						name: "PS",
						targetType: "planetscale",
						organization: "my-org",
						authCredentials: JSON.stringify({ token: "not-a-service-token" }),
					}),
				)
				.pipe(Effect.flip)
			assert.include(badCredentials.message, "tokenId")

			const missingUrl = yield* service
				.create(orgId, new CreateScrapeTargetRequest({ name: "Prom" }))
				.pipe(Effect.flip)
			assert.include(missingUrl.message, "url is required")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("prefixes sub-target failures with the branch key in lastScrapeError", () => {
		const testDb = createTestDb(trackedDbs)
		globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			const target = yield* service.create(
				orgId,
				new CreateScrapeTargetRequest({
					name: "PlanetScale Prod",
					targetType: "planetscale",
					organization: "my-org",
					authCredentials: JSON.stringify({ tokenId: "a", tokenSecret: "b" }),
				}),
			)

			yield* service.recordScrapeResults([
				{
					targetId: target.id,
					scrapedAt: 1750000000000,
					error: "HTTP 503",
					subTargetKey: "branch-1",
				},
			])
			const failed = yield* service.get(orgId, target.id)
			assert.strictEqual(failed.lastScrapeError, "[branch:branch-1] HTTP 503")

			// Any branch success clears the rollup error.
			yield* service.recordScrapeResults([
				{ targetId: target.id, scrapedAt: 1750000015000, error: null, subTargetKey: "branch-2" },
			])
			const recovered = yield* service.get(orgId, target.id)
			assert.isNull(recovered.lastScrapeError)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("persists scheduled check rows and lists them newest-first", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			const target = yield* service.create(
				orgId,
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
				}),
			)

			const scrapedAt = 1750000000000
			yield* TestClock.setTime(scrapedAt + 30_000)
			yield* service.recordScrapeResults([
				{
					targetId: target.id,
					scrapedAt,
					error: null,
					durationMs: 250,
					samplesScraped: 120,
					samplesPostMetricRelabeling: 118,
				},
				{
					targetId: target.id,
					scrapedAt: scrapedAt + 15_000,
					error: "target returned HTTP 503",
					subTargetKey: "branch-1",
					durationMs: 1100,
				},
			])

			const checks = yield* service.listChecks(orgId, target.id, {})
			assert.lengthOf(checks, 2)
			assert.strictEqual(checks[0]?.checkedAt.getTime(), scrapedAt + 15_000)
			assert.strictEqual(checks[0]?.error, "target returned HTTP 503")
			assert.strictEqual(checks[0]?.subTargetKey, "branch-1")
			assert.strictEqual(checks[0]?.durationMs, 1100)
			assert.isNull(checks[0]?.samplesScraped)
			assert.strictEqual(checks[1]?.checkedAt.getTime(), scrapedAt)
			assert.isNull(checks[1]?.error)
			assert.strictEqual(checks[1]?.subTargetKey, "")
			assert.strictEqual(checks[1]?.durationMs, 250)
			assert.strictEqual(checks[1]?.samplesScraped, 120)
			assert.strictEqual(checks[1]?.samplesPostRelabel, 118)

			// Time-range + limit filtering.
			const limited = yield* service.listChecks(orgId, target.id, { limit: 1 })
			assert.lengthOf(limited, 1)
			assert.strictEqual(limited[0]?.checkedAt.getTime(), scrapedAt + 15_000)
			const windowed = yield* service.listChecks(orgId, target.id, {
				startTime: scrapedAt - 1,
				endTime: scrapedAt + 1,
			})
			assert.lengthOf(windowed, 1)
			assert.strictEqual(windowed[0]?.checkedAt.getTime(), scrapedAt)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("manual probes update the target but record no check rows", () => {
		const testDb = createTestDb(trackedDbs)
		globalThis.fetch = (async () => new Response("up 1\n", { status: 200 })) as typeof fetch
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			const target = yield* service.create(
				orgId,
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
				}),
			)

			yield* TestClock.setTime(1750000000000)
			const probed = yield* service.probe(orgId, target.id)
			assert.isTrue(probed.success)
			assert.isNotNull(probed.lastScrapeAt)

			const checks = yield* service.listChecks(orgId, target.id, {})
			assert.lengthOf(checks, 0)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("prunes check rows older than the 24h retention window", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			const target = yield* service.create(
				orgId,
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
				}),
			)

			const now = 1750000000000
			yield* TestClock.setTime(now)
			yield* service.recordScrapeResults([
				{ targetId: target.id, scrapedAt: now - 25 * 60 * 60 * 1000, error: null },
				{ targetId: target.id, scrapedAt: now - 60 * 60 * 1000, error: null },
			])

			const checks = yield* service.listChecks(orgId, target.id, {})
			assert.lengthOf(checks, 1)
			assert.strictEqual(checks[0]?.checkedAt.getTime(), now - 60 * 60 * 1000)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("listChecks rejects targets that belong to another org", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const target = yield* service.create(
				asOrgId("org_1"),
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
				}),
			)

			const error = yield* service.listChecks(asOrgId("org_2"), target.id, {}).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/ScrapeTargetNotFoundError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("delete removes the target and returns its id; a later get is NotFound", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			const target = yield* service.create(
				orgId,
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
				}),
			)

			const deleted = yield* service.delete(orgId, target.id)
			assert.strictEqual(deleted.id, target.id)

			const afterList = yield* service.list(orgId)
			assert.lengthOf(afterList.targets, 0)
			const getError = yield* service.get(orgId, target.id).pipe(Effect.flip)
			assert.strictEqual(getError._tag, "@maple/http/errors/ScrapeTargetNotFoundError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("delete rejects a target owned by another org and leaves it intact", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const target = yield* service.create(
				asOrgId("org_1"),
				new CreateScrapeTargetRequest({
					name: "Node Exporter",
					url: "https://metrics.example.com/metrics",
					scrapeIntervalSeconds: asScrapeIntervalSeconds(15),
				}),
			)

			const error = yield* service.delete(asOrgId("org_2"), target.id).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/ScrapeTargetNotFoundError")

			// The owning org still sees it.
			const stillThere = yield* service.get(asOrgId("org_1"), target.id)
			assert.strictEqual(stillThere.id, target.id)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("planetscale targets accept credential-less planetscale_oauth auth", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const target = yield* service.create(
				asOrgId("org_1"),
				new CreateScrapeTargetRequest({
					name: "Managed PlanetScale",
					targetType: "planetscale",
					organization: "acme",
					authType: "planetscale_oauth",
				}),
			)
			assert.strictEqual(target.authType, "planetscale_oauth")
			assert.isFalse(target.hasCredentials)

			// Switching a token row to planetscale_oauth clears the stored credentials.
			const tokenTarget = yield* service.create(
				asOrgId("org_1"),
				new CreateScrapeTargetRequest({
					name: "Manual PlanetScale",
					targetType: "planetscale",
					organization: "other-org",
					authType: "token",
					authCredentials: JSON.stringify({ tokenId: "tok", tokenSecret: "sec" }),
				}),
			)
			assert.isTrue(tokenTarget.hasCredentials)
			const switched = yield* service.update(asOrgId("org_1"), tokenTarget.id, {
				authType: "planetscale_oauth",
			})
			assert.strictEqual(switched.authType, "planetscale_oauth")
			assert.isFalse(switched.hasCredentials)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("prometheus targets reject the planetscale_oauth auth type", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* ScrapeTargetsService
			const error = yield* service
				.create(
					asOrgId("org_1"),
					new CreateScrapeTargetRequest({
						name: "Node Exporter",
						url: "https://metrics.example.com/metrics",
						authType: "planetscale_oauth",
					}),
				)
				.pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/ScrapeTargetValidationError")
			assert.include(error.message, "only valid for PlanetScale targets")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
