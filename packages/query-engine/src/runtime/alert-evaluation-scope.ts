import { Cache, Context, Effect, Equal, Exit, Hash, Option } from "effect"
import type { QueryEngineValidationError, WarehouseQueryPathError } from "@maple/domain/http"
import type { BucketGroupObs, QueryEngineWarehouse } from "./query-engine"

type BucketError = QueryEngineValidationError | WarehouseQueryPathError
type Buckets = ReadonlyArray<BucketGroupObs>

class BucketLookup implements Equal.Equal {
	constructor(
		readonly owner: QueryEngineWarehouse<never>,
		readonly key: string,
		readonly load: Effect.Effect<Buckets, BucketError>,
	) {}

	[Hash.symbol](): number {
		return Hash.combine(Hash.hash(this.owner))(Hash.string(this.key))
	}

	[Equal.symbol](other: Equal.Equal): boolean {
		return other instanceof BucketLookup && other.owner === this.owner && other.key === this.key
	}
}

const CurrentBucketCache = Context.Reference<Cache.Cache<BucketLookup, Buckets, BucketError> | undefined>(
	"@maple/query-engine/AlertEvaluationBucketCache",
	{ defaultValue: () => undefined },
)

/**
 * Share alert bucket reads only inside this invocation. Call at the scheduler
 * boundary, never around a long-lived service layer: Worker I/O cannot be shared
 * across requests. Capacity bounds retained group/bucket arrays, and failures
 * expire immediately so a later rule can retry a transient failure.
 */
export const withAlertEvaluationScope = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
	Effect.gen(function* () {
		const cache = yield* Cache.makeWith((lookup: BucketLookup) => lookup.load, {
			capacity: 32,
			timeToLive: (exit) => (Exit.isSuccess(exit) ? "90 seconds" : 0),
		})
		return yield* Effect.provideService(effect, CurrentBucketCache, cache)
	})

export const memoizeAlertBuckets = (
	owner: QueryEngineWarehouse<never>,
	key: string,
	load: Effect.Effect<Buckets, BucketError>,
): Effect.Effect<Buckets, BucketError> =>
	Effect.gen(function* () {
		const cache = yield* CurrentBucketCache
		if (!cache) return yield* load
		const lookup = new BucketLookup(owner, key, load)
		const cached = yield* Cache.getOption(cache, lookup)
		yield* Effect.annotateCurrentSpan({
			"cache.bucket": "qe-evaluate-buckets",
			"cache.backend": "invocation",
			"cache.hit": Option.isSome(cached),
		})
		return yield* Option.isSome(cached) ? Effect.succeed(cached.value) : Cache.get(cache, lookup)
	})
