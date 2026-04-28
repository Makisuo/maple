// Copied from alchemy-effect to stay API-compatible for a future migration:
//   https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/Cloudflare/Workers/Rpc.ts
//
// RPC envelope encoding/decoding + bridge factories used by the Durable Object
// and Workflow modules. `DurableObjectShape` is redeclared locally (rather
// than imported from `./durable-object-namespace.ts`) to avoid a module cycle;
// it must stay in sync with the canonical definition there.
import type * as cf from "@cloudflare/workers-types"

import * as Cause from "effect/Cause"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import type { HttpServerError } from "effect/unstable/http/HttpServerError"
import * as Socket from "effect/unstable/socket/Socket"
import type { HttpEffect } from "./http.ts"
import { fromCloudflareFetcher } from "./fetcher.ts"
import { serveWebRequest } from "./http-server.ts"
import { fromWebSocket } from "./websocket.ts"

// Local redeclaration to avoid importing from durable-object-namespace.ts
// (which imports from this file). Must match the exported shape there.
interface DurableObjectShapeLocal {
	fetch?: HttpEffect<any>
	alarm?: (alarmInfo?: cf.AlarmInvocationInfo) => Effect.Effect<void, never, never>
	webSocketMessage?: (socket: any, message: string | ArrayBuffer) => Effect.Effect<void>
	webSocketClose?: (socket: any, code: number, reason: string, wasClean: boolean) => Effect.Effect<void>
}

export const StreamTag = "~alchemy/rpc/stream"
export const ErrorTag = "~alchemy/rpc/error"
export const StreamErrorTag = "~alchemy/rpc/stream-error"

type StreamEncoding = "bytes" | "jsonl"

export type RpcStreamEnvelope = {
	_tag: typeof StreamTag
	encoding: StreamEncoding
	body: ReadableStream<Uint8Array>
}

export class RpcDecodeError extends Data.TaggedError("RpcDecodeError")<{
	readonly cause: unknown
}> {
	override get message() {
		return this.cause instanceof Error ? this.cause.message : String(this.cause)
	}
}

export class RpcCallError extends Data.TaggedError("RpcCallError")<{
	readonly method: string
	readonly cause: unknown
}> {
	override get message() {
		return `RPC call to "${this.method}" failed: ${
			this.cause instanceof Error ? this.cause.message : String(this.cause)
		}`
	}
}

export class RpcRemoteStreamError extends Data.TaggedError("RpcRemoteStreamError")<{
	readonly error: unknown
}> {}

export type RpcErrorEnvelope = {
	_tag: typeof ErrorTag
	error: unknown
}

export type RpcStreamErrorMarker = {
	_tag: typeof StreamErrorTag
	error: unknown
}

export const isRpcStreamErrorMarker = (value: unknown): value is RpcStreamErrorMarker =>
	typeof value === "object" &&
	value !== null &&
	"_tag" in value &&
	value._tag === StreamErrorTag &&
	"error" in value

export const isRpcErrorEnvelope = (value: unknown): value is RpcErrorEnvelope =>
	typeof value === "object" &&
	value !== null &&
	"_tag" in value &&
	value._tag === ErrorTag &&
	"error" in value

export const encodeRpcError = (error: unknown): unknown => {
	if (error === null || error === undefined) return error
	if (typeof error !== "object") return error

	const obj = error as Record<string, unknown>
	if ("_tag" in obj && typeof obj._tag === "string") {
		const out: Record<string, unknown> = {}
		for (const key of Object.keys(obj)) {
			out[key] = obj[key]
		}
		if (error instanceof Error && !("message" in out)) {
			out.message = (error as Error).message
		}
		return out
	}

	if (error instanceof Error) {
		return { name: error.name, message: error.message, stack: error.stack }
	}

	return error
}

export const isRpcStreamEnvelope = (value: unknown): value is RpcStreamEnvelope =>
	typeof value === "object" &&
	value !== null &&
	"_tag" in value &&
	value._tag === StreamTag &&
	"encoding" in value &&
	(value.encoding === "bytes" || value.encoding === "jsonl") &&
	"body" in value &&
	value.body instanceof ReadableStream

export const fromRpcReadableStream = (
	body: ReadableStream<Uint8Array>,
	encoding: StreamEncoding,
): Stream.Stream<any, Socket.SocketError | RpcDecodeError | RpcRemoteStreamError> => {
	const stream = Stream.fromReadableStream({
		evaluate: () => body,
		onError: (cause) =>
			Socket.isSocketError(cause)
				? cause
				: new Socket.SocketError({
						reason: new Socket.SocketReadError({ cause }),
					}),
	})

	if (encoding === "bytes") {
		return stream
	}

	return stream.pipe(
		Stream.decodeText,
		Stream.splitLines,
		Stream.filter((line) => line.length > 0),
		Stream.mapEffect((line) =>
			Effect.try({
				try: () => JSON.parse(line),
				catch: (cause) => new RpcDecodeError({ cause }),
			}),
		),
		Stream.flatMap((value) =>
			isRpcStreamErrorMarker(value)
				? Stream.fail(new RpcRemoteStreamError({ error: value.error }))
				: Stream.succeed(value),
		),
	)
}

export const fromRpcStreamEnvelope = (
	envelope: RpcStreamEnvelope,
): Stream.Stream<any, Socket.SocketError | RpcDecodeError | RpcRemoteStreamError> =>
	fromRpcReadableStream(envelope.body, envelope.encoding)

export const decodeRpcValue = (value: unknown) => {
	if (isRpcStreamEnvelope(value)) {
		return fromRpcReadableStream(value.body, value.encoding)
	}

	if (value instanceof ReadableStream) {
		return fromRpcReadableStream(value, "bytes")
	}

	return value
}

export const decodeRpcResult = (value: unknown): Effect.Effect<unknown, unknown> => {
	if (isRpcErrorEnvelope(value)) {
		return Effect.fail(value.error)
	}
	return Effect.succeed(decodeRpcValue(value))
}

export const makeRpcStub = <Shape>(stub: any): Shape => {
	const fetcher = fromCloudflareFetcher(stub)

	return new Proxy(fetcher, {
		get: (target: any, prop) =>
			prop in target
				? target[prop]
				: (...args: any[]) =>
						Effect.tryPromise({
							try: () => stub[prop](...args),
							catch: (cause) => new RpcCallError({ method: String(prop), cause }),
						}).pipe(Effect.flatMap(decodeRpcResult)),
	}) as Shape
}

export const makeDurableObjectBridge =
	(
		DurableObject: abstract new (state: unknown, env: unknown) => cf.DurableObject,
		getExport: (
			name: string,
		) => Promise<(state: unknown, env: unknown) => Effect.Effect<Record<string, unknown>>>,
	) =>
	(className: string) =>
		class DurableObjectBridge extends DurableObject {
			readonly object: Promise<DurableObjectShapeLocal>

			async fetch(request: cf.Request): Promise<cf.Response> {
				const methods = await this.object
				if (methods.fetch) {
					const fetch = methods.fetch as HttpEffect<never>
					const response = await serveWebRequest(
						request as unknown as globalThis.Request,
						fetch,
					).pipe(Effect.runPromise)
					return response as any
				} else {
					return new Response("Method not found", { status: 404 }) as any
				}
			}

			async alarm(alarmInfo?: cf.AlarmInvocationInfo) {
				const methods = await this.object
				if (methods.alarm) {
					await Effect.runPromise(methods.alarm(alarmInfo))
				}
			}

			async webSocketMessage(ws: cf.WebSocket, message: string | ArrayBuffer) {
				const methods = await this.object
				if (methods.webSocketMessage) {
					const socket = fromWebSocket(ws)
					const value = methods.webSocketMessage(socket, message)
					if (Effect.isEffect(value)) {
						await Effect.runPromise(value as Effect.Effect<void>)
					}
				}
			}

			async webSocketClose(ws: cf.WebSocket, code: number, reason: string, wasClean: boolean) {
				const methods = await this.object
				if (methods.webSocketClose) {
					const socket = fromWebSocket(ws)
					const value = methods.webSocketClose(socket, code, reason, wasClean)
					if (Effect.isEffect(value)) {
						await Effect.runPromise(value as Effect.Effect<void>)
					}
				}
			}

			constructor(
				state: {
					blockConcurrencyWhile: (fn: () => Promise<unknown>) => Promise<unknown>
				},
				env: unknown,
			) {
				super(state, env)

				this.object = state.blockConcurrencyWhile(async () => {
					const makeDurableObject = await getExport(className)
					return await Effect.runPromise(makeDurableObject(state, env))
				}) as Promise<any>

				return new Proxy(this, {
					get: (target: any, prop) =>
						prop in target
							? target[prop]
							: async (...args: unknown[]) => {
									const methods = await this.object
									const method = methods[prop as keyof DurableObjectShapeLocal] as any
									const value = method(...args)
									if (Effect.isEffect(value)) {
										const exit = await Effect.runPromiseExit(
											value as Effect.Effect<unknown, never>,
										)
										if (exit._tag === "Success") {
											if (Stream.isStream(exit.value)) {
												return await Effect.runPromise(
													toRpcStream(
														exit.value,
													) as Effect.Effect<RpcStreamEnvelope>,
												)
											}
											return exit.value
										}
										const failReason = exit.cause.reasons.find(Cause.isFailReason)
										if (failReason) {
											return {
												_tag: ErrorTag,
												error: encodeRpcError(failReason.error),
											} satisfies RpcErrorEnvelope
										}
										const dieReason = exit.cause.reasons.find(Cause.isDieReason)
										throw (
											dieReason?.defect ??
											new Error("RPC method failed with an unexpected cause")
										)
									}
									return value
								},
				})
			}
		}

export const makeWorkflowBridge =
	(
		WorkflowEntrypoint: abstract new (
			ctx: unknown,
			env: unknown,
		) => { run(event: any, step: any): Promise<unknown> },
		getExport: (
			name: string,
		) => Promise<(env: unknown) => Effect.Effect<Effect.Effect<unknown, never, any>>>,
	) =>
	(className: string) =>
		class WorkflowBridge extends WorkflowEntrypoint {
			readonly body: Promise<Effect.Effect<unknown, never, any>>
			readonly env: unknown

			constructor(ctx: unknown, env: unknown) {
				super(ctx, env)
				this.env = env
				this.body = getExport(className).then((factory) => Effect.runPromise(factory(env)))
			}

			async run(event: any, step: any): Promise<unknown> {
				const body = await this.body
				const { WorkflowEvent, WorkflowStep } = await import("./workflow.ts")
				return Effect.runPromise(
					body.pipe(
						Effect.provideService(WorkflowEvent, wrapWorkflowEvent(event)),
						Effect.provideService(WorkflowStep, wrapWorkflowStep(step)),
					) as Effect.Effect<unknown>,
				)
			}
		}

const wrapWorkflowEvent = (event: any): { payload: unknown; timestamp: Date; instanceId: string } => ({
	payload: event.payload,
	timestamp: event.timestamp instanceof Date ? event.timestamp : new Date(event.timestamp),
	instanceId: event.instanceId ?? "",
})

const wrapWorkflowStep = (step: any) => ({
	do: <T>(name: string, effect: Effect.Effect<T>): Effect.Effect<T> =>
		Effect.tryPromise(() => step.do(name, () => Effect.runPromise(effect)) as Promise<T>),
	sleep: (name: string, duration: string | number): Effect.Effect<void> =>
		Effect.tryPromise(() => step.sleep(name, duration)),
	sleepUntil: (name: string, timestamp: Date | number): Effect.Effect<void> =>
		Effect.tryPromise(() =>
			step.sleepUntil(name, timestamp instanceof Date ? timestamp.toISOString() : timestamp),
		),
})

const encodeStreamErrorMarker = (cause: Cause.Cause<unknown>): string => {
	const failReason = cause.reasons.find(Cause.isFailReason)
	const error = failReason ? encodeRpcError(failReason.error) : undefined
	return (
		JSON.stringify({
			_tag: StreamErrorTag,
			error,
		} satisfies RpcStreamErrorMarker) + "\n"
	)
}

const appendStreamErrors = (s: Stream.Stream<string, unknown>) =>
	s.pipe(Stream.catchCause((cause) => Stream.succeed(encodeStreamErrorMarker(cause))))

export const toRpcStream = (stream: Stream.Stream<any, any, any>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const [head, rest] = yield* Stream.peel(stream, Sink.head())

			if (Option.isSome(head) && head.value instanceof Uint8Array) {
				return {
					_tag: StreamTag,
					encoding: "bytes",
					body: Stream.toReadableStream(rest.pipe(Stream.prepend([head.value]))),
				} satisfies RpcStreamEnvelope
			}

			const body = Option.isSome(head) ? rest.pipe(Stream.prepend([head.value])) : rest

			return {
				_tag: StreamTag,
				encoding: "jsonl",
				body: Stream.toReadableStream(
					appendStreamErrors(body.pipe(Stream.map((value) => JSON.stringify(value) + "\n"))).pipe(
						Stream.encodeText,
					),
				),
			} satisfies RpcStreamEnvelope
		}),
	).pipe(
		Effect.catchCause((cause) => {
			const failReason = cause.reasons.find(Cause.isFailReason)
			if (failReason) {
				return Effect.succeed({
					_tag: StreamTag,
					encoding: "jsonl",
					body: Stream.toReadableStream(
						Stream.succeed(encodeStreamErrorMarker(cause)).pipe(Stream.encodeText),
					),
				} satisfies RpcStreamEnvelope)
			}
			return Effect.die(Cause.squash(cause))
		}),
	)

// The HttpServerError import is kept for consumers that need it in type
// positions (e.g. DurableObjectStub signatures). Export re-exports below.
export type { HttpServerError }
