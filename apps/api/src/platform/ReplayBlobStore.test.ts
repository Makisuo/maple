import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { layerFromEnvRecord } from "@maple/effect-cloudflare/worker-environment"
import { ReplayBlobStore, replayObjectKey, REPLAY_BLOBS_BINDING } from "./ReplayBlobStore"

const gzip = async (text: string): Promise<Uint8Array> => {
	const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))
	return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Minimal stand-in for the R2 binding: only `get` is exercised. */
const fakeBucket = (objects: Record<string, Uint8Array>, onGet?: (key: string) => void) => ({
	get: async (key: string) => {
		onGet?.(key)
		const bytes = objects[key]
		if (!bytes) return null
		return { bytes: async () => bytes }
	},
})

const runWithBucket = <A>(
	bucket: unknown,
	program: (store: typeof ReplayBlobStore.Service) => Effect.Effect<A>,
) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const store = yield* ReplayBlobStore
			return yield* program(store)
		}).pipe(
			Effect.provide(
				ReplayBlobStore.layer.pipe(
					Layer.provide(layerFromEnvRecord({ [REPLAY_BLOBS_BINDING]: bucket })),
				),
			),
		),
	)

describe("replayObjectKey", () => {
	// These expectations are duplicated verbatim in `replay_object_key`'s tests
	// in apps/ingest/src/r2.rs. Nothing at runtime reconciles the two — the
	// writer and the reader agree only by construction — and a divergence reads
	// to a user as "every recording is empty", not as an error. So both suites
	// pin the same strings.
	it("matches the ingest gateway's key scheme", () => {
		expect(replayObjectKey("org_123", "sess_abc", 7)).toBe("v1/org_123/sess_abc/00000007.json.gz")
	})

	it("zero-pads so lexicographic order is playback order", () => {
		const keys = [
			replayObjectKey("o", "s", 10),
			replayObjectKey("o", "s", 2),
			replayObjectKey("o", "s", 1),
		].sort()
		expect(keys).toEqual([
			"v1/o/s/00000001.json.gz",
			"v1/o/s/00000002.json.gz",
			"v1/o/s/00000010.json.gz",
		])
	})

	it("does not truncate a chunk seq wider than the pad", () => {
		expect(replayObjectKey("o", "s", 123_456_789)).toBe("v1/o/s/123456789.json.gz")
	})
})

describe("ReplayBlobStore.hydrate", () => {
	const events = '[{"type":2,"timestamp":1}]'

	it("fills in payloads for blob-backed chunks", async () => {
		const bucket = fakeBucket({
			"v1/org_1/sess_1/00000000.json.gz": await gzip(events),
		})
		const result = await runWithBucket(bucket, (store) =>
			store.hydrate("org_1", "sess_1", [{ chunkSeq: 0, events: "", byteSize: 26 }]),
		)
		expect(result).toEqual([{ chunkSeq: 0, events, byteSize: 26 }])
	})

	it("leaves pre-cutover chunks untouched and never fetches them", async () => {
		// The dual-read. A row written before the R2 cutover carries its payload
		// inline; going to the bucket for it would 404 and silently drop a chunk
		// that was there all along.
		const fetched: string[] = []
		const bucket = fakeBucket({}, (key) => fetched.push(key))
		const result = await runWithBucket(bucket, (store) =>
			store.hydrate("org_1", "sess_1", [{ chunkSeq: 0, events }]),
		)
		expect(result).toEqual([{ chunkSeq: 0, events }])
		expect(fetched).toEqual([])
	})

	it("drops a chunk whose object is missing rather than failing the request", async () => {
		const bucket = fakeBucket({
			"v1/org_1/sess_1/00000001.json.gz": await gzip(events),
		})
		const result = await runWithBucket(bucket, (store) =>
			store.hydrate("org_1", "sess_1", [
				{ chunkSeq: 0, events: "" },
				{ chunkSeq: 1, events: "" },
			]),
		)
		expect(result).toEqual([{ chunkSeq: 1, events }])
	})

	it("preserves chunk order despite concurrent fetches", async () => {
		const objects: Record<string, Uint8Array> = {}
		for (let seq = 0; seq < 20; seq++) {
			objects[replayObjectKey("org_1", "sess_1", seq)] = await gzip(`[${seq}]`)
		}
		const result = await runWithBucket(objects && fakeBucket(objects), (store) =>
			store.hydrate(
				"org_1",
				"sess_1",
				Array.from({ length: 20 }, (_, seq) => ({ chunkSeq: seq, events: "" })),
			),
		)
		expect(result.map((chunk) => chunk.events)).toEqual(
			Array.from({ length: 20 }, (_, seq) => `[${seq}]`),
		)
	})

	it("is a no-op when the binding is absent", async () => {
		// Self-hosted and the Docker image of this API have no R2 at all. Every
		// row there carries its payload inline, so hydration must pass through
		// rather than erroring on a missing binding.
		const chunks = [{ chunkSeq: 0, events }]
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* ReplayBlobStore
				return yield* store.hydrate("org_1", "sess_1", chunks)
			}).pipe(
				Effect.provide(ReplayBlobStore.layer.pipe(Layer.provide(layerFromEnvRecord({})))),
			),
		)
		expect(result).toEqual(chunks)
	})
})
