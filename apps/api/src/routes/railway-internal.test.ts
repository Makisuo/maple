import { assert, describe, it } from "@effect/vitest"
import { Option, Schema } from "effect"
import { RailwayResultReportList } from "@maple/domain/http"
import type { RailwayConnectionRow, RailwayTargetRow } from "@maple/db"
import { toInternalRailwayTarget } from "./railway-internal.http"

const TARGET_ID = "11111111-1111-4111-8111-111111111111"
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222"
const INGEST_KEY = "maple_pk_test_key"

const connection: RailwayConnectionRow = {
	id: CONNECTION_ID,
	orgId: "org_1",
	tokenType: "account",
	tokenCiphertext: "cipher",
	tokenIv: "iv",
	tokenTag: "tag",
	externalAccountName: "David",
	connectedByUserId: "user_1",
	enabled: true,
	lastValidatedAt: null,
	lastValidationError: null,
	lastValidationErrorAt: null,
	createdAt: new Date(0),
	updatedAt: new Date(0),
}

const target: RailwayTargetRow = {
	id: TARGET_ID,
	orgId: "org_1",
	connectionId: CONNECTION_ID,
	projectId: "proj-1",
	projectName: "maple-demo",
	environmentId: "env-1",
	environmentName: "production",
	enabled: true,
	logsEnabled: true,
	metricsEnabled: true,
	metricsIntervalSeconds: 300,
	servicesJson: JSON.stringify([{ id: "svc-1", name: "api" }]),
	servicesDiscoveredAt: new Date(0),
	logWatermarkAt: new Date(5_000),
	metricsWatermarkAt: null,
	lastLogAt: null,
	lastMetricsAt: null,
	lastSuccessAt: null,
	lastError: null,
	lastErrorAt: null,
	createdAt: new Date(0),
	updatedAt: new Date(0),
}

describe("toInternalRailwayTarget", () => {
	it("marshals a joined row with the decrypted token and ingest key", () => {
		const result = toInternalRailwayTarget(
			{ target, connection, token: "railway-token", services: [{ id: "svc-1", name: "api" }] },
			INGEST_KEY,
		)
		assert.isTrue(Option.isSome(result))
		if (Option.isNone(result)) return
		assert.strictEqual(result.value.id, TARGET_ID)
		assert.strictEqual(result.value.connectionId, CONNECTION_ID)
		assert.strictEqual(result.value.token, "railway-token")
		assert.strictEqual(result.value.tokenType, "account")
		assert.strictEqual(result.value.environmentId, "env-1")
		assert.deepStrictEqual(
			result.value.services.map((service) => ({ id: service.id, name: service.name })),
			[{ id: "svc-1", name: "api" }],
		)
		assert.strictEqual(result.value.logWatermarkMs, 5_000)
		assert.isNull(result.value.metricsWatermarkMs)
		assert.strictEqual(result.value.ingestKey, INGEST_KEY)
	})

	it("drops rows that violate the schema brands instead of failing the list", () => {
		const outOfRange = toInternalRailwayTarget(
			{
				target: { ...target, metricsIntervalSeconds: 5 },
				connection,
				token: "railway-token",
				services: [],
			},
			INGEST_KEY,
		)
		assert.isTrue(Option.isNone(outOfRange))

		const badTokenType = toInternalRailwayTarget(
			{
				target,
				connection: { ...connection, tokenType: "project" },
				token: "railway-token",
				services: [],
			},
			INGEST_KEY,
		)
		assert.isTrue(Option.isNone(badTokenType))
	})
})

describe("RailwayResultReportList decoding", () => {
	const decode = Schema.decodeUnknownSync(RailwayResultReportList)

	it("accepts log and metrics reports with optional fields", () => {
		const reports = decode([
			{
				targetId: TARGET_ID,
				kind: "logs",
				at: 1_750_000_000_000,
				error: null,
				recordsIngested: 250,
				newLogWatermarkMs: 1_750_000_000_500,
			},
			{
				targetId: TARGET_ID,
				kind: "metrics",
				at: 1_750_000_000_000,
				error: "Railway API returned HTTP 429",
				rateLimited: true,
			},
		])
		assert.strictEqual(reports.length, 2)
		assert.strictEqual(reports[0]!.kind, "logs")
		assert.strictEqual(reports[1]!.rateLimited, true)
	})

	it("rejects reports with an unknown kind", () => {
		assert.throws(() =>
			decode([{ targetId: TARGET_ID, kind: "traces", at: 0, error: null }]),
		)
	})
})
