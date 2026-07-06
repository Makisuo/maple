import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";

/** Shared options of `Query.persist` and `Store.persist`. */
export interface PersistOptions<A, I> {
  readonly key: string;
  readonly schema: Schema.Codec<A, I>;
  readonly timeToLive?: Duration.Input;
}

/**
 * A schema-encoded `KeyValueStore` slot with a freshness timestamp.
 * Best-effort by construction: storage and codec failures are logged as
 * warnings — a failed load reads as a miss, a failed save is skipped — so
 * persistence never affects the primitive it is attached to.
 */
export const makeSlot = <A, I>(
  options: PersistOptions<A, I>,
): Effect.Effect<
  {
    readonly load: Effect.Effect<Option.Option<A>>;
    readonly save: (value: A) => Effect.Effect<void>;
  },
  never,
  KeyValueStore.KeyValueStore
> =>
  Effect.gen(function* () {
    const store = KeyValueStore.toSchemaStore(
      yield* KeyValueStore.KeyValueStore,
      Schema.Struct({ savedAt: Schema.Number, value: options.schema }),
    );
    const ttlMillis =
      options.timeToLive === undefined
        ? undefined
        : Duration.toMillis(Duration.fromInputUnsafe(options.timeToLive));

    const load = Effect.gen(function* () {
      const entry = yield* store.get(options.key);
      if (Option.isNone(entry)) return Option.none<A>();
      if (ttlMillis !== undefined) {
        const now = yield* Clock.currentTimeMillis;
        if (now - entry.value.savedAt >= ttlMillis) return Option.none<A>();
      }
      return Option.some(entry.value.value);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.map(
          Effect.logWarning(`persist(${options.key}): restore failed`, cause),
          () => Option.none<A>(),
        ),
      ),
    );

    const save = (value: A): Effect.Effect<void> =>
      Effect.flatMap(Clock.currentTimeMillis, (savedAt) =>
        store.set(options.key, { savedAt, value }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`persist(${options.key}): save failed`, cause),
        ),
      );

    return { load, save };
  });
