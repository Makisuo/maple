// Simplified port of alchemy-effect's DurableObjectNamespace factory:
//   https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/Cloudflare/Workers/DurableObjectNamespace.ts
//
// Upstream uses an IaC-aware class+effect hybrid (`effectClass` +
// `taggedFunction`) so `yield* MyDO` resolves the namespace handle. That
// hybrid depends on alchemy's `Worker` / `Output` / `Platform` IaC
// abstractions we are NOT porting.
//
// This port keeps the same authoring ergonomics for the class itself:
//
//   export class ChatAgent extends DurableObjectNamespace<ChatAgent>()(
//     "ChatAgent",
//     Effect.gen(function* () {
//       return Effect.gen(function* () {
//         const state = yield* DurableObjectState
//         return { fetch: ..., sayHi: () => Effect.succeed("hi") }
//       })
//     }),
//   ) {}
//
// …but replaces `yield* ChatAgent` (alchemy's sugar) with an explicit helper:
//
//   const chat = yield* namespaceOf(ChatAgent)
//   const stub = chat.getByName("room-123")
//
// When migrating to alchemy-effect later, search-and-replace
// `namespaceOf(X)` → `X`.
//
// IMPORTANT: This module statically imports from `cloudflare:workers`; it can
// only be loaded inside a Cloudflare Worker isolate.
import type * as cf from "@cloudflare/workers-types"
import { DurableObject } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import type { HttpServerError } from "effect/unstable/http/HttpServerError"
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { DurableObjectState, fromDurableObjectState } from "./durable-object-state.ts"
import type { HttpEffect } from "./http.ts"
import { makeDurableObjectBridge, makeRpcStub } from "./rpc.ts"
import type { DurableWebSocket } from "./websocket.ts"
import { WorkerEnvironment } from "./worker-environment.ts"

export type DurableObjectId = cf.DurableObjectId
export type AlarmInvocationInfo = cf.AlarmInvocationInfo

export interface DurableObjectShape {
	fetch?: HttpEffect<any>
	alarm?: (alarmInfo?: AlarmInvocationInfo) => Effect.Effect<void, never, never>
	webSocketMessage?: (socket: DurableWebSocket, message: string | ArrayBuffer) => Effect.Effect<void>
	webSocketClose?: (
		socket: DurableWebSocket,
		code: number,
		reason: string,
		wasClean: boolean,
	) => Effect.Effect<void>
}

export type DurableObjectStub<Shape> = {
	[K in keyof Shape]: Shape[K]
} & {
	fetch(
		request: HttpServerRequest.HttpServerRequest,
	): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerError, never>
}

export interface DurableObjectNamespaceHandle<Shape = unknown> {
	readonly name: string
	getByName(name: string): DurableObjectStub<Shape>
	idFromName(name: string): DurableObjectId
	idFromString(id: string): DurableObjectId
	newUniqueId(): DurableObjectId
}

// ---------------------------------------------------------------------------
// Module-level registry: name -> init effect
//
// The DO bridge class needs to look up the user-provided impl at CF-
// instantiation time. The impl is registered when the factory is called
// (at module evaluation in the DO's source file) and retrieved by the
// bridge constructor (when CF invokes `new ClassName(state, env)`).
// ---------------------------------------------------------------------------

type DurableObjectImpl = Effect.Effect<
	Effect.Effect<Record<string, unknown>, never, DurableObjectState>,
	never,
	any
>

const implRegistry = new Map<string, DurableObjectImpl>()

export const registerDurableObjectImpl = (name: string, impl: DurableObjectImpl): void => {
	implRegistry.set(name, impl)
}

export const getDurableObjectImpl = (name: string): DurableObjectImpl | undefined => implRegistry.get(name)

// ---------------------------------------------------------------------------
// Bridge base class — built once, parameterised per DO name.
// ---------------------------------------------------------------------------

const Bridge = makeDurableObjectBridge(
	DurableObject as unknown as abstract new (state: unknown, env: unknown) => cf.DurableObject,
	async (name: string) => {
		const impl = implRegistry.get(name)
		if (!impl) {
			throw new Error(
				`Durable Object impl for '${name}' is not registered. Ensure the class module is loaded before CF instantiates the DO.`,
			)
		}
		return (state: unknown, env: unknown) =>
			Effect.gen(function* () {
				const doState = fromDurableObjectState(state as cf.DurableObjectState)
				const innerEffect = yield* impl
				const methods = yield* innerEffect.pipe(
					Effect.provideService(DurableObjectState, doState),
					Effect.provideService(WorkerEnvironment, env as Record<string, unknown>),
				)
				return methods as Record<string, unknown>
			}) as Effect.Effect<Record<string, unknown>>
	},
)

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Define a Durable Object class with an Effect-based runtime implementation.
 *
 * Usage:
 * ```ts
 * export class ChatAgent extends DurableObjectNamespace<ChatAgent>()(
 *   "ChatAgent",
 *   Effect.gen(function* () {
 *     // Phase 1 — shared init (bindings, etc.)
 *     return Effect.gen(function* () {
 *       // Phase 2 — per-instance setup
 *       const state = yield* DurableObjectState
 *       return {
 *         fetch: Effect.gen(function* () { ... }),
 *         sayHi: () => Effect.succeed("hi"),
 *       }
 *     })
 *   }),
 * ) {}
 * ```
 *
 * Export the resulting class as the DO binding target in wrangler.jsonc.
 * Use `namespaceOf(ChatAgent)` in a worker handler to get a namespace
 * handle with `.getByName(id)` → typed stub.
 */
export const DurableObjectNamespace = <_Self = unknown>() => {
	return <Shape extends DurableObjectShape, InitReq = never>(
		name: string,
		impl: Effect.Effect<Effect.Effect<Shape, never, DurableObjectState>, never, InitReq>,
	) => {
		registerDurableObjectImpl(name, impl as unknown as DurableObjectImpl)
		return Bridge(name) as unknown as new (state: cf.DurableObjectState, env: unknown) => cf.DurableObject
	}
}

/**
 * Resolve a namespace handle for a DO class registered via
 * `DurableObjectNamespace`. The `Shape` type parameter controls the
 * methods exposed on the stub returned by `.getByName(id)`.
 *
 * The class reference is used purely to look up the registered name — the
 * actual binding comes from the worker env at runtime.
 */
export const namespaceOf = <Shape = unknown>(
	classOrName: { name: string } | string,
): Effect.Effect<DurableObjectNamespaceHandle<Shape>, never, WorkerEnvironment> =>
	Effect.gen(function* () {
		const env = yield* WorkerEnvironment
		const name = typeof classOrName === "string" ? classOrName : classOrName.name
		const binding = env[name] as cf.DurableObjectNamespace | undefined
		if (!binding || typeof binding.getByName !== "function") {
			return yield* Effect.die(
				new Error(
					`Worker env has no DurableObjectNamespace binding named '${name}'. Check wrangler.jsonc.`,
				),
			)
		}
		return {
			name,
			getByName: (id: string) => makeRpcStub<DurableObjectStub<Shape>>(binding.getByName(id)),
			idFromName: (id: string) => binding.idFromName(id),
			idFromString: (id: string) => binding.idFromString(id),
			newUniqueId: () => binding.newUniqueId(),
		}
	})
