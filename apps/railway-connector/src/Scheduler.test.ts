import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { InternalRailwayTarget, RailwayResultReport } from "@maple/domain/http"
import { loopFingerprint, loopKey, loopsForTarget, sendResultsInChunks } from "./Scheduler"

const decodeTarget = Schema.decodeUnknownSync(InternalRailwayTarget)

const target = decodeTarget({
	id: "11111111-1111-4111-8111-111111111111",
	orgId: "org_1",
	connectionId: "22222222-2222-4222-8222-222222222222",
	tokenType: "account",
	token: "railway-token",
	projectId: "proj-1",
	projectName: "maple-demo",
	environmentId: "env-1",
	environmentName: "production",
	services: [
		{ id: "svc-1", name: "api" },
		{ id: "svc-2", name: "worker" },
	],
	logsEnabled: true,
	metricsEnabled: true,
	metricsIntervalSeconds: 300,
	logWatermarkMs: null,
	metricsWatermarkMs: null,
	ingestKey: "maple_pk_test",
})

const report = (at: number) =>
	new RailwayResultReport({
		targetId: target.id,
		kind: "metrics",
		at,
		error: null,
	})

describe("loopsForTarget", () => {
	it("expands to one log loop plus one metrics loop per service", () => {
		const loops = loopsForTarget(target)
		assert.deepStrictEqual(loops.map(loopKey), [
			`${target.id}:logs`,
			`${target.id}:metrics:svc-1`,
			`${target.id}:metrics:svc-2`,
		])
	})

	it("honors the logs/metrics toggles", () => {
		const logsOnly = decodeTarget({ ...target, token: target.token, metricsEnabled: false })
		assert.deepStrictEqual(loopsForTarget(logsOnly).map(loopKey), [`${target.id}:logs`])

		const metricsOnly = decodeTarget({ ...target, logsEnabled: false })
		assert.strictEqual(loopsForTarget(metricsOnly).length, 2)
	})
})

describe("loopFingerprint", () => {
	it("changes when the token, interval, or services change — but not on watermarks", () => {
		const loops = loopsForTarget(target)
		const logsLoop = loops[0]!
		const metricsLoop = loops[1]!

		const watermarked = decodeTarget({ ...target, logWatermarkMs: 99, metricsWatermarkMs: 42 })
		assert.strictEqual(loopFingerprint(logsLoop), loopFingerprint(loopsForTarget(watermarked)[0]!))
		assert.strictEqual(
			loopFingerprint(metricsLoop),
			loopFingerprint(loopsForTarget(watermarked)[1]!),
		)

		const rotated = decodeTarget({ ...target, token: "new-token" })
		assert.notStrictEqual(loopFingerprint(logsLoop), loopFingerprint(loopsForTarget(rotated)[0]!))

		const renamed = decodeTarget({
			...target,
			services: [
				{ id: "svc-1", name: "renamed" },
				{ id: "svc-2", name: "worker" },
			],
		})
		assert.notStrictEqual(loopFingerprint(logsLoop), loopFingerprint(loopsForTarget(renamed)[0]!))

		const retimed = decodeTarget({ ...target, metricsIntervalSeconds: 600 })
		assert.notStrictEqual(
			loopFingerprint(metricsLoop),
			loopFingerprint(loopsForTarget(retimed)[1]!),
		)
		// The logs loop does not restart on a metrics interval change.
		assert.strictEqual(loopFingerprint(logsLoop), loopFingerprint(loopsForTarget(retimed)[0]!))
	})
})

describe("sendResultsInChunks", () => {
	it.effect("sends everything in order and reports nothing unsent", () =>
		Effect.gen(function* () {
			const sent: number[] = []
			const outcome = yield* sendResultsInChunks(
				[report(1), report(2), report(3)],
				2,
				(chunk) => Effect.sync(() => void sent.push(chunk.length)),
			)
			assert.deepStrictEqual(sent, [2, 1])
			assert.strictEqual(outcome.unsent.length, 0)
			assert.isNull(outcome.error)
		}),
	)

	it.effect("stops at the first failed chunk and returns the remainder", () =>
		Effect.gen(function* () {
			let calls = 0
			const outcome = yield* sendResultsInChunks([report(1), report(2), report(3)], 1, () => {
				calls += 1
				return calls === 2 ? Effect.fail(new Error("boom")) : Effect.void
			})
			assert.strictEqual(outcome.unsent.length, 2)
			assert.strictEqual(outcome.unsent[0]!.at, 2)
			assert.strictEqual(outcome.error?.message, "boom")
		}),
	)
})
