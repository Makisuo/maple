import { Context, Effect, Layer, Option } from "effect"
import { R2Bucket, type R2BucketClient } from "@maple/effect-cloudflare/r2-bucket"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"

// ---------------------------------------------------------------------------
// ReplayBlobStore — reads rrweb chunk payloads out of R2.
//
// The ingest gateway stores each replay chunk's gzipped rrweb array as an
// object and writes a `session_replay_events` row that carries only the chunk's
// metadata, with an empty `Events`. This service turns those rows back into the
// inline payloads the player already expects, so the HTTP response shape is
// unchanged.
//
// Two states are normal, not errors:
//
//   - **No binding.** Self-hosted installs and the Docker image of this API have
//     no R2. `WorkerEnvironment` resolves to `{}` outside a Worker isolate, so
//     `bindOptional` yields `None` and hydration becomes a no-op.
//   - **Non-empty `events` on a row.** That row predates the R2 cutover (or came
//     from a BYO-ClickHouse org, which never stops writing inline). It passes
//     through untouched. This is the dual-read, and it is the whole migration
//     strategy: no backfill, the old rows age out on the table's 30-day TTL.
// ---------------------------------------------------------------------------

/** Binding name; must match the key in `apps/api/alchemy.run.ts`. */
export const REPLAY_BLOBS_BINDING = "REPLAY_BLOBS"

/**
 * Object key for one replay chunk.
 *
 * **Must stay byte-identical to `replay_object_key` in `apps/ingest/src/r2.rs`.**
 * Nothing at runtime cross-checks the two — a divergence reads as "every
 * recording is empty", so the shared shape is asserted in both test suites.
 */
export const replayObjectKey = (orgId: string, sessionId: string, chunkSeq: number): string =>
	`v1/${orgId}/${sessionId}/${String(chunkSeq).padStart(8, "0")}.json.gz`

/** The subset of a `session_replay_events` row hydration needs. */
export interface HydratableChunk {
	readonly chunkSeq: number
	readonly events: string
}

export interface ReplayBlobStoreShape {
	/**
	 * Fill in `events` for every blob-backed chunk, preserving order.
	 *
	 * Chunks whose object is missing are **dropped**, not failed: a single
	 * absent chunk should cost you that slice of the recording, not the whole
	 * session. This matches how the player already tolerates a chunk it can't
	 * parse.
	 */
	readonly hydrate: <T extends HydratableChunk>(
		orgId: string,
		sessionId: string,
		chunks: readonly T[],
	) => Effect.Effect<T[]>
}

// Chunk fetches are independent; the player needs all of them before it can
// build the Replayer, so latency is the max, not the sum — but only if they
// overlap. Sequential gets across a long session would be a visible regression
// against the single ClickHouse round trip this replaces.
const FETCH_CONCURRENCY = 8

const decodeGzip = (bytes: Uint8Array): Promise<string> =>
	new Response(
		new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")),
	).text()

const makeHydrate =
	(bucket: R2BucketClient) =>
	<T extends HydratableChunk>(orgId: string, sessionId: string, chunks: readonly T[]) =>
		Effect.forEach(
			chunks,
			(chunk) => {
				// Pre-cutover row: the payload is already in hand.
				if (chunk.events !== "") return Effect.succeed(Option.some(chunk))
				const key = replayObjectKey(orgId, sessionId, chunk.chunkSeq)
				return bucket.get(key).pipe(
					Effect.flatMap((object) =>
						object === null
							? Effect.succeed(Option.none<T>())
							: object.bytes().pipe(
									Effect.flatMap((bytes) => Effect.promise(() => decodeGzip(bytes))),
									Effect.map((events) => Option.some({ ...chunk, events })),
								),
					),
					// A failed fetch degrades the recording rather than the request.
					// Logged at warning because a nonzero rate here means either the
					// bucket lifecycle is outrunning the table TTL or the ingest-side
					// key scheme has drifted from this one.
					Effect.catch((cause) =>
						Effect.logWarning("replay chunk payload unavailable").pipe(
							Effect.annotateLogs({ orgId, sessionId, key, cause: String(cause) }),
							Effect.as(Option.none<T>()),
						),
					),
				)
			},
			{ concurrency: FETCH_CONCURRENCY },
		).pipe(Effect.map((results) => results.filter(Option.isSome).map((result) => result.value)))

export class ReplayBlobStore extends Context.Service<ReplayBlobStore, ReplayBlobStoreShape>()(
	"@maple/api/platform/ReplayBlobStore",
	{
		make: Effect.gen(function* () {
			// The R2 client's methods each demand `WorkerEnvironment` again at call
			// time, so capture it here and close over it. Otherwise the requirement
			// leaks into every caller's type, and the routes would have to know
			// they're on Cloudflare.
			const env = yield* WorkerEnvironment
			const bucket = yield* R2Bucket.bindOptional(R2Bucket(REPLAY_BLOBS_BINDING))
			if (Option.isNone(bucket)) {
				// Expected on self-hosted / Docker / tests. Every row will carry its
				// payload inline there, so hydration has nothing to do.
				return { hydrate: (_orgId, _sessionId, chunks) => Effect.succeed([...chunks]) }
			}
			const hydrate = makeHydrate(bucket.value)
			return {
				hydrate: (orgId, sessionId, chunks) =>
					hydrate(orgId, sessionId, chunks).pipe(Effect.provideService(WorkerEnvironment, env)),
			}
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}

export const ReplayBlobStoreLive = ReplayBlobStore.layer.pipe(Layer.provide(WorkerEnvironment.layer))
