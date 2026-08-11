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
 */
export const forkRequestScoped = <A, E, R>(work: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const scope = yield* Effect.serviceOption(Scope.Scope)
		return Option.isSome(scope) ? yield* Effect.forkIn(work, scope.value) : yield* Effect.forkChild(work)
	})
