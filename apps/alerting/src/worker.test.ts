import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer } from "effect"
import { env as workerEnv } from "../test/stubs/cloudflare-workers"
import { buildLayer, catchTickFailure, selectScheduledProgram, type ScheduledTickPrograms } from "./worker"

const cronCases = [
	["*/5 * * * *", ["anomaly", "cloudflareAnalytics", "planetScale"]],
	["*/15 * * * *", ["digest"]],
	["0 * * * *", ["serviceMapRollup"]],
	["* * * * *", ["alert", "error", "escalation"]],
] as const

describe("alerting Effect root", () => {
	it.effect("acquires the production layer graph", () =>
		Effect.scoped(Layer.build(buildLayer(workerEnv))).pipe(Effect.asVoid),
	)

	for (const [cron, expected] of cronCases) {
		it.effect(`dispatches ${cron} to its characterized tick group`, () => {
			const calls: Array<string> = []
			const tick = (name: string) => Effect.sync(() => calls.push(name)).pipe(Effect.asVoid)
			const ticks = {
				alert: tick("alert"),
				anomaly: tick("anomaly"),
				cloudflareAnalytics: tick("cloudflareAnalytics"),
				digest: tick("digest"),
				error: tick("error"),
				escalation: tick("escalation"),
				planetScale: tick("planetScale"),
				serviceMapRollup: tick("serviceMapRollup"),
			} satisfies ScheduledTickPrograms

			return selectScheduledProgram(cron, ticks).pipe(
				Effect.tap(() =>
					Effect.sync(() => expect(calls.toSorted()).toEqual([...expected].toSorted())),
				),
			)
		})
	}

	it.effect("fails closed for an unknown cron", () => {
		const calls: Array<string> = []
		const tick = (name: string) => Effect.sync(() => calls.push(name)).pipe(Effect.asVoid)
		const ticks = {
			alert: tick("alert"),
			anomaly: tick("anomaly"),
			cloudflareAnalytics: tick("cloudflareAnalytics"),
			digest: tick("digest"),
			error: tick("error"),
			escalation: tick("escalation"),
			planetScale: tick("planetScale"),
			serviceMapRollup: tick("serviceMapRollup"),
		} satisfies ScheduledTickPrograms

		return selectScheduledProgram("1 2 3 4 5", ticks).pipe(
			Effect.tap(() => Effect.sync(() => expect(calls).toEqual([]))),
		)
	})

	it.effect("isolates ordinary tick failures", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.fail("boom").pipe(
				catchTickFailure("expected test failure"),
				Effect.exit,
			)
			expect(Exit.isSuccess(exit)).toBe(true)
		}),
	)

	it.effect("preserves interrupt-only causes for graceful worker teardown", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.interrupt.pipe(catchTickFailure("must not be logged"), Effect.exit)
			expect(Exit.isFailure(exit)).toBe(true)
			if (Exit.isFailure(exit)) {
				expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
			}
		}),
	)
})
