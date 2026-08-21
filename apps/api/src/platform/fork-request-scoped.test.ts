import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { forkRequestScoped } from "./fork-request-scoped"
import {
	PgConnectionScope,
	type PgConnectionScopeApi,
	PgConnectionScopeClosedError,
	withPgConnectionScopeOf,
} from "./pg-connection-scope"
import { toDatabaseError } from "./DatabaseLive"

/**
 * A scope with the real state machine's one property that matters here: once
 * `close()` has run, `run` refuses synchronously instead of dialing. `runs`
 * counts calls that arrived while the scope was still open.
 */
const refusingScope = () => {
	let closed = false
	let runs = 0
	const scope: PgConnectionScopeApi = {
		run: <T>(fn: (db: never) => Promise<T>) =>
			Effect.suspend(() => {
				if (closed) {
					return Effect.fail(
						toDatabaseError(new PgConnectionScopeClosedError({ message: "closed" })),
					)
				}
				runs += 1
				return Effect.promise(() => fn(undefined as never))
			}),
		close: async () => {
			closed = true
		},
	}
	return { scope, runs: () => runs }
}

const dbCall = Effect.gen(function* () {
	const scope = yield* PgConnectionScope
	return yield* scope!.run(() => Promise.resolve("touched"))
})

describe("forkRequestScoped", () => {
	// Mirrors the production nesting: `HttpEffect.toHandled` creates the request
	// Scope OUTSIDE the middleware stack, so it outlives `pgConnectionMiddleware`.
	// A handler that forks and then finishes with no further async work must
	// still get its background DB call onto the socket before the middleware's
	// `ensuring` releases it — this is the `ApiKeysService.touchLastUsed` shape
	// on `POST /mcp`, which used to land every call as `SCOPE_CLOSED`.
	it.effect("runs the forked DB call before the connection scope closes", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { scope, runs } = refusingScope()
				let outcome: "ok" | "closed" | "unset" = "unset"

				yield* withPgConnectionScopeOf(
					scope,
					Effect.gen(function* () {
						yield* forkRequestScoped(
							dbCall.pipe(
								Effect.tap(() => Effect.sync(() => (outcome = "ok"))),
								Effect.catchTag("@maple/api/lib/DatabaseError", () =>
									Effect.sync(() => (outcome = "closed")),
								),
							),
						)
						// Handler returns synchronously — no await between the fork and
						// the response.
						return "response"
					}),
				)

				assert.strictEqual(runs(), 1)
				assert.strictEqual(outcome, "ok")
			}),
		),
	)

	it.effect("outside any request Scope, forks a child of the calling fiber", () =>
		Effect.gen(function* () {
			const { scope, runs } = refusingScope()
			const fiber = yield* withPgConnectionScopeOf(scope, forkRequestScoped(dbCall))
			// The child is a real fiber the caller can still observe.
			const result = yield* Fiber.join(fiber)
			assert.strictEqual(result, "touched")
			assert.strictEqual(runs(), 1)
		}),
	)
})
