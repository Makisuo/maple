import { assert, describe, it } from "@effect/vitest"
import { VcsQueueError, type VcsSyncJob } from "@maple/domain/http"
import { WorkerEnvironment } from "@maple/effect-cloudflare"
import { Effect, Exit, Layer, Tracer } from "effect"
import {
	MESSAGING_DESTINATION,
	MESSAGING_SYSTEM,
	QUEUE_BATCH_MAX_BYTES,
	QUEUE_BATCH_MAX_MESSAGES,
	VcsSyncQueue,
} from "@/services/integrations/vcs/VcsSyncQueue"
import { findError } from "./harness"

type CapturedMessage = { readonly body: unknown }

// Fake Cloudflare Queue binding that captures each chunk passed to `sendBatch`.
// `reject` makes every call throw so the VcsQueueError path can be exercised.
const fakeQueueEnv = (opts?: { reject?: boolean }) => {
	const chunks: CapturedMessage[][] = []
	const binding = {
		send: async () => {},
		sendBatch: async (messages: ReadonlyArray<CapturedMessage>) => {
			if (opts?.reject) throw new Error("simulated queue outage")
			chunks.push([...messages])
		},
	}
	const layer = Layer.succeed(WorkerEnvironment, { VCS_SYNC_QUEUE: binding })
	return { layer, chunks }
}

// An env with NO queue binding, to exercise the "missing binding" guard.
const noBindingEnv = () => Layer.succeed(WorkerEnvironment, {})

const chunkSizes = (chunks: ReadonlyArray<ReadonlyArray<CapturedMessage>>): number[] =>
	chunks.map((c) => c.length)

// Byte size of a captured message body, matching the producer's own measure.
const encoder = new TextEncoder()
const bodyBytes = (m: CapturedMessage): number => encoder.encode(JSON.stringify(m.body)).length

// Checks per-chunk limits rather than exact arrays so tests don't break if a
// fixture's encoded size shifts without the chunking logic changing.
const assertChunksValid = (chunks: ReadonlyArray<ReadonlyArray<CapturedMessage>>): void => {
	for (const chunk of chunks) {
		assert.ok(chunk.length >= 1, "no empty chunks are emitted")
		assert.ok(
			chunk.length <= QUEUE_BATCH_MAX_MESSAGES,
			`chunk holds ${chunk.length} <= ${QUEUE_BATCH_MAX_MESSAGES} messages`,
		)
		const bytes = chunk.reduce((sum, m) => sum + bodyBytes(m), 0)
		if (chunk.length > 1) {
			assert.ok(
				bytes <= QUEUE_BATCH_MAX_BYTES,
				`multi-message chunk ${bytes} <= ${QUEUE_BATCH_MAX_BYTES} bytes`,
			)
		}
	}
}

const installSyncJob = (i: number): VcsSyncJob => ({
	kind: "installation-sync",
	provider: "github",
	externalInstallationId: String(i),
	reason: "scheduled",
})

// A push job whose single commit message is `messageBytes` long, so each encoded
// message size is controllable for the byte-bound chunk-split tests.
const pushJob = (i: number, messageBytes: number): VcsSyncJob => ({
	kind: "push",
	provider: "github",
	externalInstallationId: "42",
	externalRepoId: String(i),
	branch: "main",
	commits: [
		{
			sha: "a".repeat(40),
			message: "x".repeat(messageBytes),
			authorName: null,
			authorEmail: null,
			authorLogin: null,
			authorAvatarUrl: null,
			authoredAt: null,
			committedAt: 1,
			htmlUrl: `https://github.com/octo/repo/commit/${"a".repeat(40)}`,
		},
	],
})

const provideQueue = (layer: Layer.Layer<WorkerEnvironment>) =>
	Effect.provide(VcsSyncQueue.layer.pipe(Layer.provide(layer)))

/** Records every span so the producer span's kind and messaging attributes are assertable. */
const makeRecordingTracer = () => {
	const spans: Array<Tracer.NativeSpan> = []
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	return { spans, tracer }
}

// Producer kind + messaging.system/destination are what put the queue on the
// service map as an external dependency; an Internal span with neither is
// invisible there. The consumer side (vcs-sync-runtime) mirrors these.
describe("VcsSyncQueue producer spans", () => {
	it.effect("sends emit Producer-kind spans with messaging semconv attributes", () => {
		const { layer } = fakeQueueEnv()
		return Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()
			const queue = yield* VcsSyncQueue

			yield* queue.sendBatch([installSyncJob(1)]).pipe(Effect.withTracer(tracer))
			yield* queue.send(installSyncJob(2)).pipe(Effect.withTracer(tracer))

			const produced = spans.filter((span) => span.name.startsWith("VcsSyncQueue."))
			assert.deepStrictEqual(produced.map((span) => span.name).sort(), [
				"VcsSyncQueue.send",
				"VcsSyncQueue.sendBatch",
			])
			for (const span of produced) {
				assert.strictEqual(span.kind, "producer", `${span.name} is Producer-kind`)
				assert.strictEqual(span.attributes.get("messaging.system"), MESSAGING_SYSTEM)
				assert.strictEqual(span.attributes.get("messaging.destination.name"), MESSAGING_DESTINATION)
				assert.strictEqual(span.attributes.get("messaging.operation.name"), "send")
			}
		}).pipe(provideQueue(layer))
	})
})

describe("VcsSyncQueue.sendBatch chunking", () => {
	it.effect("splits a list over the message-count cap into capped chunks", () => {
		const { layer, chunks } = fakeQueueEnv()
		const jobs = Array.from({ length: 230 }, (_, i) => installSyncJob(i))
		return Effect.gen(function* () {
			const queue = yield* VcsSyncQueue
			yield* queue.sendBatch(jobs)
			assertChunksValid(chunks)
			assert.deepStrictEqual(chunkSizes(chunks), [
				QUEUE_BATCH_MAX_MESSAGES,
				QUEUE_BATCH_MAX_MESSAGES,
				30,
			])
			// No job is dropped: every chunk concatenated reconstructs the full list.
			assert.strictEqual(
				chunks.reduce((n, c) => n + c.length, 0),
				jobs.length,
			)
		}).pipe(provideQueue(layer))
	})

	it.effect("splits on the cumulative byte cap, not just the count", () => {
		const { layer, chunks } = fakeQueueEnv()
		// 5 × ~100 KB jobs: 256 KB holds at most 2 per batch → [2, 2, 1].
		const jobs = Array.from({ length: 5 }, (_, i) => pushJob(i, 100_000))
		return Effect.gen(function* () {
			const queue = yield* VcsSyncQueue
			yield* queue.sendBatch(jobs)
			// Sanity: a single job is under the byte cap (so the split is genuine).
			assert.ok(bodyBytes(chunks.flat()[0]!) < QUEUE_BATCH_MAX_BYTES)
			assertChunksValid(chunks)
			assert.deepStrictEqual(chunkSizes(chunks), [2, 2, 1])
		}).pipe(provideQueue(layer))
	})

	it.effect("emits a single oversized message as its own chunk rather than dropping it", () => {
		const { layer, chunks } = fakeQueueEnv()
		// One job larger than the whole batch byte cap, flanked by small jobs: the
		// big one must land alone, and neither neighbour may be lost.
		const big = pushJob(1, QUEUE_BATCH_MAX_BYTES + 10_000)
		const jobs = [installSyncJob(0), big, installSyncJob(2)]
		return Effect.gen(function* () {
			const queue = yield* VcsSyncQueue
			yield* queue.sendBatch(jobs)
			assertChunksValid(chunks)
			const oversizedChunk = chunks.find(
				(c) => c.length === 1 && bodyBytes(c[0]!) > QUEUE_BATCH_MAX_BYTES,
			)
			assert.ok(oversizedChunk, "oversized message is sent in a chunk of its own")
			// All three jobs survive across the chunks (nothing silently dropped).
			assert.strictEqual(
				chunks.reduce((n, c) => n + c.length, 0),
				jobs.length,
			)
		}).pipe(provideQueue(layer))
	})

	it.effect("sends a small list in a single batch", () => {
		const { layer, chunks } = fakeQueueEnv()
		const jobs = [installSyncJob(1), installSyncJob(2)]
		return Effect.gen(function* () {
			const queue = yield* VcsSyncQueue
			yield* queue.sendBatch(jobs)
			assertChunksValid(chunks)
			assert.deepStrictEqual(chunkSizes(chunks), [2])
		}).pipe(provideQueue(layer))
	})

	it.effect("an empty list sends nothing", () => {
		const { layer, chunks } = fakeQueueEnv()
		return Effect.gen(function* () {
			const queue = yield* VcsSyncQueue
			yield* queue.sendBatch([])
			assert.deepStrictEqual(chunks, [])
		}).pipe(provideQueue(layer))
	})
})

describe("VcsSyncQueue error paths", () => {
	it.effect("fails with VcsQueueError when the queue binding is missing", () => {
		return Effect.gen(function* () {
			const queue = yield* VcsSyncQueue
			const exit = yield* Effect.exit(queue.sendBatch([installSyncJob(1)]))
			assert.ok(Exit.isFailure(exit), "sendBatch fails without a binding")
			const error = findError(exit)
			assert.ok(error instanceof VcsQueueError)
			assert.match(error.message, /Missing queue binding/)
		}).pipe(provideQueue(noBindingEnv()))
	})

	it.effect("maps a queue.sendBatch rejection to VcsQueueError", () => {
		const { layer } = fakeQueueEnv({ reject: true })
		return Effect.gen(function* () {
			const queue = yield* VcsSyncQueue
			const exit = yield* Effect.exit(queue.sendBatch([installSyncJob(1)]))
			assert.ok(Exit.isFailure(exit), "sendBatch surfaces the rejection")
			const error = findError(exit)
			assert.ok(error instanceof VcsQueueError)
			assert.match(error.message, /simulated queue outage/)
		}).pipe(provideQueue(layer))
	})
})
