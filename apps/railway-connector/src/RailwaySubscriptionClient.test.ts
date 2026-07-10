import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Result } from "effect"
import {
	ENVIRONMENT_LOGS_SUBSCRIPTION,
	runGraphqlWsSubscription,
	type WebSocketLike,
} from "./RailwaySubscriptionClient"

/** In-memory WebSocket double driving the graphql-transport-ws handshake. */
class FakeSocket implements WebSocketLike {
	readonly sent: Array<Record<string, unknown>> = []
	closed: { code?: number; reason?: string } | null = null
	private listeners = new Map<string, Array<(event: never) => void>>()

	send(data: string): void {
		this.sent.push(JSON.parse(data) as Record<string, unknown>)
	}

	close(code?: number, reason?: string): void {
		this.closed = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) }
	}

	addEventListener(type: string, listener: (event: never) => void): void {
		const existing = this.listeners.get(type) ?? []
		this.listeners.set(type, [...existing, listener])
	}

	emit(type: "open"): void
	emit(type: "message", event: { data: unknown }): void
	emit(type: "close", event: { code?: number; reason?: string }): void
	emit(type: "error"): void
	emit(type: string, event?: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) {
			;(listener as (event: unknown) => void)(event)
		}
	}

	serverSays(message: Record<string, unknown>): void {
		this.emit("message", { data: JSON.stringify(message) })
	}
}

const start = (socket: FakeSocket, onNext: (data: unknown) => void) =>
	Effect.gen(function* () {
		const fiber = yield* Effect.forkChild(
			Effect.result(
				runGraphqlWsSubscription({
					wsUrl: "wss://backboard.example/graphql/v2",
					token: "railway-token",
					query: ENVIRONMENT_LOGS_SUBSCRIPTION,
					variables: { environmentId: "env-1" },
					onNext,
					webSocketFactory: () => socket,
				}),
			),
		)
		// Let the callback register its listeners before the fake emits events.
		yield* Effect.yieldNow
		return fiber
	})

describe("runGraphqlWsSubscription", () => {
	it.effect("handshakes, subscribes, and pumps next payloads", () =>
		Effect.gen(function* () {
			const received: unknown[] = []
			const socket = new FakeSocket()
			const fiber = yield* start(socket, (data) => received.push(data))

			socket.emit("open")
			assert.strictEqual(socket.sent[0]!.type, "connection_init")
			const initPayload = socket.sent[0]!.payload as Record<string, string>
			assert.strictEqual(initPayload.authorization, "Bearer railway-token")

			socket.serverSays({ type: "connection_ack" })
			assert.strictEqual(socket.sent[1]!.type, "subscribe")
			const subscribePayload = socket.sent[1]!.payload as { query: string; variables: unknown }
			assert.include(subscribePayload.query, "environmentLogs")
			assert.deepStrictEqual(subscribePayload.variables, { environmentId: "env-1" })

			socket.serverSays({
				id: "1",
				type: "next",
				payload: { data: { environmentLogs: [{ message: "hi" }] } },
			})
			assert.deepStrictEqual(received, [{ environmentLogs: [{ message: "hi" }] }])

			// Server pings are answered with pongs to keep the connection alive.
			socket.serverSays({ type: "ping" })
			assert.strictEqual(socket.sent.at(-1)!.type, "pong")

			yield* Fiber.interrupt(fiber)
		}),
	)

	it.effect("fails when the server rejects the subscription, flagging auth errors", () =>
		Effect.gen(function* () {
			const socket = new FakeSocket()
			const fiber = yield* start(socket, () => {})

			socket.emit("open")
			socket.serverSays({ type: "connection_ack" })
			socket.serverSays({ id: "1", type: "error", payload: [{ message: "Not Authorized" }] })

			const result = yield* Fiber.join(fiber)
			assert.isTrue(Result.isFailure(result))
			if (Result.isFailure(result)) {
				assert.isTrue(result.failure.unauthorized)
				assert.include(result.failure.message, "Not Authorized")
			}
		}),
	)

	it.effect("fails on close and on server-initiated complete so the caller reconnects", () =>
		Effect.gen(function* () {
			const closedSocket = new FakeSocket()
			const closedFiber = yield* start(closedSocket, () => {})
			closedSocket.emit("open")
			closedSocket.serverSays({ type: "connection_ack" })
			closedSocket.emit("close", { code: 1006, reason: "" })
			const closedResult = yield* Fiber.join(closedFiber)
			assert.isTrue(Result.isFailure(closedResult))
			if (Result.isFailure(closedResult)) {
				assert.include(closedResult.failure.message, "code 1006")
				assert.isFalse(closedResult.failure.unauthorized)
			}

			const completedSocket = new FakeSocket()
			const completedFiber = yield* start(completedSocket, () => {})
			completedSocket.emit("open")
			completedSocket.serverSays({ type: "connection_ack" })
			completedSocket.serverSays({ id: "1", type: "complete" })
			const completedResult = yield* Fiber.join(completedFiber)
			assert.isTrue(Result.isFailure(completedResult))
			if (Result.isFailure(completedResult)) {
				assert.include(completedResult.failure.message, "completed")
			}
		}),
	)

	it.effect("interruption closes the socket", () =>
		Effect.gen(function* () {
			const socket = new FakeSocket()
			const fiber = yield* start(socket, () => {})
			socket.emit("open")
			socket.serverSays({ type: "connection_ack" })

			yield* Fiber.interrupt(fiber)
			assert.isNotNull(socket.closed)
		}),
	)
})
