// BOUNDARY: Test doubles preserve opaque values so the consuming boundary can be exercised.
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option, Stream } from "effect"
import {
	fromRpcReadableStream,
	fromRpcStreamEnvelope,
	RpcRemoteStreamError,
	toRpcStream,
} from "@maple/effect-cloudflare"

const runRoundTrip = (stream: Stream.Stream<unknown, unknown>) =>
	Effect.gen(function* () {
		const envelope = yield* toRpcStream(stream)
		return yield* Effect.exit(Stream.runCollect(fromRpcStreamEnvelope(envelope)))
	})

const firstFailure = (exit: Exit.Exit<unknown, unknown>): unknown =>
	Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined

describe("effect-cloudflare RPC streams", () => {
	it.effect("recognizes a legacy defect marker whose error field was omitted", () =>
		Effect.gen(function* () {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('{"_tag":"~alchemy/rpc/stream-error"}\n'))
					controller.close()
				},
			})
			const exit = yield* Effect.exit(Stream.runCollect(fromRpcReadableStream(body, "jsonl")))
			expect(Exit.isFailure(exit)).toBe(true)
			expect(firstFailure(exit)).toBeInstanceOf(RpcRemoteStreamError)
		}),
	)

	it.effect("keeps Effect.fail(undefined) in the error channel", () =>
		Effect.gen(function* () {
			const stream = Stream.concat(Stream.succeed({ ok: true }), Stream.fail(undefined))
			const exit = yield* runRoundTrip(stream)
			expect(Exit.isFailure(exit)).toBe(true)
			expect(firstFailure(exit)).toBeInstanceOf(RpcRemoteStreamError)
		}),
	)

	it.effect("keeps a late defect in the error channel", () =>
		Effect.gen(function* () {
			const stream = Stream.concat(
				Stream.succeed({ ok: true }),
				Stream.fromEffect(Effect.die(new Error("boom"))),
			)
			const exit = yield* runRoundTrip(stream)
			expect(Exit.isFailure(exit)).toBe(true)
			expect(firstFailure(exit)).toBeInstanceOf(RpcRemoteStreamError)
		}),
	)
})
