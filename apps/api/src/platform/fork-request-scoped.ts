import { Effect, Option, Scope } from "effect"

/**
 * Fork background work so it cannot outlive the invocation that owns the
 * Postgres socket.
 *
 * `Effect.forkDetach` is the wrong tool for anything that touches the database.
 * A detached fiber inherits the `PgConnectionScope` reference from the request
 * context but not the request's lifetime, so it can still be running when
 * `withPgConnectionScopeOf`'s `Effect.ensuring` closes the socket. The next
 * `execute` then finds no socket and dials a new one *after the request has
 * ended*, which a Worker cannot do — and because these call sites are
 * `Effect.ignore`d, the failure is silent.
 *
 * HTTP routes always have a request `Scope` (HttpRouter provides one). Non-HTTP
 * callers — crons, queue consumers, workflows — do not, and there the calling
 * fiber IS the whole job, so it is a safe parent.
 *
 * `startImmediately` is load-bearing. The request `Scope` is created by
 * `HttpEffect.toHandled` OUTSIDE the middleware stack, so it closes AFTER
 * `pgConnectionMiddleware` has already released the socket — it does not
 * bound the fork the way the paragraph above assumes. A fork that is merely
 * *scheduled* (the default) never runs before the parent has sent the response
 * and `PgConnectionScope.close()` has flipped the scope to `Closed`; the
 * child then wakes to a `SCOPE_CLOSED` refusal, which is exactly what
 * `ApiKeysService.touchLastUsed` produced on every `POST /mcp` whose handler
 * had no further async work. Starting the child synchronously lets it reach
 * its first DB call — and take the socket — while the scope is still `Open`;
 * `close()` then drains that in-flight statement (`sql.end()` waits) instead
 * of refusing it.
 */
export const forkRequestScoped = <A, E, R>(work: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const scope = yield* Effect.serviceOption(Scope.Scope)
		return Option.isSome(scope)
			? yield* Effect.forkIn(work, scope.value, { startImmediately: true })
			: yield* Effect.forkChild(work, { startImmediately: true })
	})
