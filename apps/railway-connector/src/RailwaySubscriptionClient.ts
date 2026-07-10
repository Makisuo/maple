/**
 * Minimal graphql-transport-ws client for Railway's GraphQL subscriptions
 * (`wss://backboard.railway.com/graphql/v2`), hand-rolled over the runtime
 * WebSocket so interruption stays Effect-native and no ws dependency is
 * needed (Bun ships a spec-compliant WebSocket).
 *
 * Protocol (https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md):
 * `connection_init` (auth in the payload) → `connection_ack` → `subscribe` →
 * stream of `next` / `error` / `complete`; server `ping` answered with `pong`.
 */
import { Effect, Schema } from "effect"

export class RailwaySubscriptionError extends Schema.TaggedErrorClass<RailwaySubscriptionError>()(
	"@maple/railway-connector/RailwaySubscriptionError",
	{
		message: Schema.String,
		unauthorized: Schema.Boolean,
	},
) {}

/** The subset of the WebSocket interface the client uses (factory-injectable for tests). */
export interface WebSocketLike {
	send(data: string): void
	close(code?: number, reason?: string): void
	addEventListener(type: "open", listener: () => void): void
	addEventListener(type: "message", listener: (event: { data: unknown }) => void): void
	addEventListener(type: "close", listener: (event: { code?: number; reason?: string }) => void): void
	addEventListener(type: "error", listener: () => void): void
}

export type WebSocketFactory = (url: string, protocol: string) => WebSocketLike

const CONNECTION_ACK_TIMEOUT_MS = 15_000
const SUBSCRIPTION_ID = "1"

interface ServerMessage {
	readonly type: string
	readonly id?: string
	readonly payload?: unknown
}

const parseServerMessage = (data: unknown): ServerMessage | null => {
	if (typeof data !== "string") return null
	try {
		const parsed = JSON.parse(data) as unknown
		if (typeof parsed !== "object" || parsed === null) return null
		const message = parsed as Record<string, unknown>
		if (typeof message.type !== "string") return null
		return {
			type: message.type,
			...(typeof message.id === "string" ? { id: message.id } : {}),
			...("payload" in message ? { payload: message.payload } : {}),
		}
	} catch {
		return null
	}
}

const errorPayloadMessage = (payload: unknown): string => {
	if (Array.isArray(payload)) {
		const messages = payload
			.map((error) =>
				typeof error === "object" &&
				error !== null &&
				typeof (error as { message?: unknown }).message === "string"
					? (error as { message: string }).message
					: null,
			)
			.filter((message): message is string => message !== null)
		if (messages.length > 0) return messages.join("; ")
	}
	return "subscription error"
}

const isUnauthorizedMessage = (message: string): boolean => /not authorized|unauthorized|forbidden/i.test(message)

export interface SubscriptionOptions {
	readonly wsUrl: string
	readonly token: string
	readonly query: string
	readonly variables: Record<string, unknown>
	/**
	 * Called synchronously for every entry in a `next` payload's `data`. The
	 * callback must not throw; buffer + backpressure live in the caller.
	 */
	readonly onNext: (data: unknown) => void
	/** Injectable for tests; defaults to the runtime WebSocket. */
	readonly webSocketFactory?: WebSocketFactory
}

const defaultFactory: WebSocketFactory = (url, protocol) =>
	new WebSocket(url, [protocol]) as unknown as WebSocketLike

/**
 * Open the socket, run the handshake, and pump `next` payloads into `onNext`
 * until the server errors, completes, or the connection drops — all of which
 * fail the effect so the caller's reconnect loop takes over. Interruption
 * closes the socket. This effect never succeeds.
 */
export const runGraphqlWsSubscription = (
	options: SubscriptionOptions,
): Effect.Effect<never, RailwaySubscriptionError> =>
	Effect.callback<never, RailwaySubscriptionError>((resume, signal) => {
		const factory = options.webSocketFactory ?? defaultFactory
		let socket: WebSocketLike
		let settled = false

		const fail = (error: RailwaySubscriptionError) => {
			if (settled) return
			settled = true
			resume(Effect.fail(error))
		}

		try {
			socket = factory(options.wsUrl, "graphql-transport-ws")
		} catch (error) {
			resume(
				Effect.fail(
					new RailwaySubscriptionError({
						message: error instanceof Error ? error.message : "WebSocket construction failed",
						unauthorized: false,
					}),
				),
			)
			return
		}

		let acked = false
		const ackTimer = setTimeout(() => {
			fail(
				new RailwaySubscriptionError({
					message: `no connection_ack within ${CONNECTION_ACK_TIMEOUT_MS}ms`,
					unauthorized: false,
				}),
			)
			try {
				socket.close(1000)
			} catch {
				// already closed
			}
		}, CONNECTION_ACK_TIMEOUT_MS)

		socket.addEventListener("open", () => {
			// Railway accepts the bearer in the init payload; both spellings are
			// sent because community clients disagree on the expected key.
			socket.send(
				JSON.stringify({
					type: "connection_init",
					payload: {
						authorization: `Bearer ${options.token}`,
						Authorization: `Bearer ${options.token}`,
					},
				}),
			)
		})

		socket.addEventListener("message", (event) => {
			const message = parseServerMessage(event.data)
			if (message === null) return

			switch (message.type) {
				case "connection_ack": {
					if (acked) return
					acked = true
					clearTimeout(ackTimer)
					socket.send(
						JSON.stringify({
							id: SUBSCRIPTION_ID,
							type: "subscribe",
							payload: { query: options.query, variables: options.variables },
						}),
					)
					return
				}
				case "ping": {
					socket.send(JSON.stringify({ type: "pong" }))
					return
				}
				case "next": {
					if (message.id !== SUBSCRIPTION_ID) return
					const payload = message.payload
					if (typeof payload === "object" && payload !== null && "data" in payload) {
						options.onNext((payload as { data: unknown }).data)
					}
					return
				}
				case "error": {
					if (message.id !== SUBSCRIPTION_ID) return
					const text = errorPayloadMessage(message.payload)
					fail(
						new RailwaySubscriptionError({
							message: `subscription rejected: ${text}`,
							unauthorized: isUnauthorizedMessage(text),
						}),
					)
					try {
						socket.close(1000)
					} catch {
						// already closed
					}
					return
				}
				case "complete": {
					if (message.id !== SUBSCRIPTION_ID) return
					// A live log stream should never complete — treat it as a drop so
					// the caller reconnects.
					fail(
						new RailwaySubscriptionError({
							message: "subscription completed by server",
							unauthorized: false,
						}),
					)
					try {
						socket.close(1000)
					} catch {
						// already closed
					}
					return
				}
				default:
					return
			}
		})

		socket.addEventListener("close", (event) => {
			clearTimeout(ackTimer)
			const reason = event.reason && event.reason.length > 0 ? event.reason : `code ${event.code ?? "?"}`
			fail(
				new RailwaySubscriptionError({
					message: `connection closed: ${reason}`,
					unauthorized:
						event.code === 4401 || event.code === 4403 || isUnauthorizedMessage(event.reason ?? ""),
				}),
			)
		})

		socket.addEventListener("error", () => {
			clearTimeout(ackTimer)
			fail(new RailwaySubscriptionError({ message: "connection error", unauthorized: false }))
		})

		signal.addEventListener("abort", () => {
			clearTimeout(ackTimer)
			try {
				socket.close(1000, "interrupted")
			} catch {
				// already closed
			}
		})
	})

/** Railway's environment-wide runtime log stream (all services in the environment). */
export const ENVIRONMENT_LOGS_SUBSCRIPTION = `
subscription mapleEnvironmentLogs($environmentId: String!) {
  environmentLogs(environmentId: $environmentId) {
    timestamp
    message
    severity
    tags {
      projectId
      environmentId
      serviceId
      deploymentId
    }
    attributes {
      key
      value
    }
  }
}
`
