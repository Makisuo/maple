import type * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Event from "./event.js";
import { Registry } from "./registry.js";
import * as Store from "./store.js";

const MutationTypeId = Symbol.for("@unitflow/core/Mutation");

/**
 * A mutation's trigger: a sink-only event port that also carries the
 * mutation's direct executor, so `Mutation.call` can run the handler and
 * receive its typed result through the same port `Event.emit` fires
 * fire-and-forget. Valid as a model input and on the `ui` surface; it is not
 * a source: subscribing to it does not compile.
 */
export interface Sink<I, A, E> extends Event.Sink<I> {
  readonly [MutationTypeId]: {
    /** Runs the handler directly: state transitions, `done`, and the typed
     * result, serialized with the fire-and-forget path by the mutation's
     * semaphore. Built with the owner's context, so it needs no services. */
    readonly call: (input: I) => Effect.Effect<A, E>;
  };
}

/**
 * A remote write owned by a model: every `run` emit/call takes the mutation's
 * one permit and runs the handler (concurrent triggers queue), mirroring
 * progress into `state` (waiting -> success / failure-keeping-previous) and
 * publishing every successful result on `done`.
 */
export interface Mutation<I, A, E> {
  /** The trigger: expose it as a model input (and/or `ui` port). */
  readonly run: Sink<I, A, E>;
  readonly state: Store.Store<AsyncResult.AsyncResult<A, E>>;
  readonly done: Event.Event<A>;
}

export const make = <I, A, E, R>(
  handler: (input: I) => Effect.Effect<A, E, R>,
): Effect.Effect<Mutation<I, A, E>, never, R | Registry> =>
  Effect.gen(function* () {
    // The executor bakes the construction context in: `call` from any caller
    // runs with the owner's services and registry, so the mutation's `R`
    // never leaks to callers.
    const context = yield* Effect.context<R | Registry>();
    const semaphore = yield* Semaphore.make(1);

    const state = Store.make<AsyncResult.AsyncResult<A, E>>(AsyncResult.initial(false));
    const done = Event.make<A>();

    const runOnce = (input: I): Effect.Effect<A, E> =>
      semaphore
        .withPermit(
          Effect.gen(function* () {
            yield* Store.update(state, (current) => AsyncResult.waiting(current));
            const value = yield* handler(input).pipe(
              Effect.tapCause((cause) =>
                Store.update(state, (current) =>
                  AsyncResult.failureWithPrevious(cause, { previous: Option.some(current) }),
                ),
              ),
            );
            yield* Store.set(state, AsyncResult.success(value));
            yield* Event.emit(done, value);
            return value;
          }),
        )
        .pipe(Effect.provideContext(context));

    const channel = yield* Event.make<I>().pipe(
      Event.handler((input) => runOnce(input).pipe(Effect.catchCause(() => Effect.void))),
    );

    const run: Sink<I, A, E> = { ...channel, [MutationTypeId]: { call: runOnce } };

    return { run, state, done };
  });

/**
 * Triggers the mutation and awaits its typed result: the request/response view
 * of the same port `Event.emit` fires fire-and-forget. An optional `timeout`
 * fails with `Cause.TimeoutError` when the run does not complete in time
 * (interrupting the handler; `state` is left waiting for that run).
 */
export const call = <I, A, E>(
  sink: Sink<I, A, E>,
  input: I,
  options?: { readonly timeout?: Duration.Input },
): Effect.Effect<A, E | Cause.TimeoutError> =>
  options?.timeout === undefined
    ? sink[MutationTypeId].call(input)
    : Effect.timeout(sink[MutationTypeId].call(input), options.timeout);

/** After each successful run, emits every target's `refresh`: the mutation
 * analogue of the old reactivity-key invalidation. Targets are anything with
 * a `refresh` sink (a `Query`, a model's `inputs`, ...). */
export const invalidates =
  (...targets: ReadonlyArray<{ readonly refresh: Event.Sink<void> }>) =>
  <I, A, E, EffE, R>(
    self: Effect.Effect<Mutation<I, A, E>, EffE, R>,
  ): Effect.Effect<Mutation<I, A, E>, EffE, R | Registry> =>
    Effect.tap(self, (mutation) =>
      mutation.done.pipe(
        Event.handler(() =>
          Effect.forEach(targets, (target) => Event.emit(target.refresh), {
            discard: true,
          }),
        ),
      ),
    );
