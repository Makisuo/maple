// @vitest-environment jsdom

/**
 * `useMapleChat`'s stream reader, driven by a fake SSE body.
 *
 * The hook hand-rolls what an SDK used to do — resume cursors, reconnects, aborts — and every case
 * below is one that shipped broken and typechecked. The server half is stubbed at `fetch`, so these
 * assert the client's own contract with the wire format in `@maple/domain/chat-session`.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./use-maple-organization", () => ({ useMapleOrganizationId: () => "org_1" }))
vi.mock("@/lib/services/common/auth-headers", () => ({
	getMapleAuthHeaders: async () => ({ authorization: "Bearer test" }),
}))
vi.mock("@/lib/services/common/api-base-url", () => ({ apiBaseUrl: "https://api.test" }))

const tracedFetch = vi.fn<(name: string, url: string, init: RequestInit) => Promise<Response>>()
vi.mock("@/lib/services/common/telemetry", () => ({
	tracedFetch: (name: string, url: string, init: RequestInit) => tracedFetch(name, url, init),
}))

import { useMapleChat } from "./use-maple-chat"

/** One SSE frame, exactly as `chat-sessions.http.ts` writes it. */
const frame = (event: Record<string, unknown>): string =>
	`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`

/** A response whose body emits `chunks` and then closes — the server recycling a connection. */
const sseResponse = (chunks: ReadonlyArray<string>): Response => {
	const encoder = new TextEncoder()
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
			controller.close()
		},
	})
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

const jsonResponse = (value: unknown): Response =>
	new Response(JSON.stringify(value), {
		status: 200,
		headers: { "content-type": "application/json" },
	})

const emptyHistory = { messages: [], cursor: 0, running: false }

/** Renders the hook and exposes what a test needs to assert on. */
function Harness() {
	const chat = useMapleChat({ tabId: "tab" })
	return (
		<div>
			<span data-testid="status">{chat.status}</span>
			<span data-testid="ready">{String(chat.historyReady)}</span>
			<span data-testid="text">
				{chat.messages
					.flatMap((message) => message.parts)
					.map((part) =>
						part.type === "text"
							? part.text
							: part.type === "task"
								? `[task:${part.agent}:${part.status}]`
								: `[${part.state}]`,
					)
					.join("|")}
			</span>
			<button type="button" onClick={() => chat.sendMessage("hello")}>
				send
			</button>
			<button type="button" onClick={() => chat.stop()}>
				stop
			</button>
		</div>
	)
}

const eventsRequests = () => tracedFetch.mock.calls.filter(([, url]) => url.includes("/events"))

const cursorOf = (url: string): string => new URL(url).searchParams.get("cursor") ?? ""

beforeEach(() => {
	tracedFetch.mockReset()
})

afterEach(() => {
	cleanup()
})

describe("useMapleChat stream reader", () => {
	it("reconnects from its cursor when the stream closes without a turn-end", async () => {
		// The server closes after its 25s tail window elapses. Treating that as the end of the turn
		// left `status` at "streaming" forever, with the composer disabled and the turn still
		// running — one slow tool call was enough to trigger it.
		tracedFetch
			.mockResolvedValueOnce(jsonResponse(emptyHistory))
			.mockResolvedValueOnce(jsonResponse({ cursor: 0, messageId: "m1" }))
			.mockResolvedValueOnce(
				sseResponse([
					frame({ seq: 1, type: "turn-start", messageId: "m1" }),
					frame({ seq: 2, type: "text-delta", messageId: "m1", text: "part" }),
				]),
			)
			.mockResolvedValueOnce(
				sseResponse([
					frame({ seq: 3, type: "text-delta", messageId: "m1", text: " two" }),
					frame({ seq: 4, type: "turn-end", messageId: "m1", reason: "stop" }),
				]),
			)

		render(<Harness />)
		await waitFor(() => expect(screen.getByTestId("ready").textContent).toBe("true"))
		await act(async () => {
			screen.getByText("send").click()
		})

		await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready"))

		const streams = eventsRequests()
		assert.lengthOf(streams, 2, "the client reconnected rather than giving up on EOF")
		assert.equal(cursorOf(streams[0]![1]), "0")
		// Resumed from the last seq it saw — no replay, no gap.
		assert.equal(cursorOf(streams[1]![1]), "2")
		assert.include(screen.getByTestId("text").textContent ?? "", "part two")
	})

	it("skips a frame it cannot decode instead of looping on it", async () => {
		// A throwing decode reconnected from *before* the bad frame, so the server replayed it and
		// the client threw again until the retry budget ran out and the conversation died.
		tracedFetch
			.mockResolvedValueOnce(jsonResponse(emptyHistory))
			.mockResolvedValueOnce(jsonResponse({ cursor: 0, messageId: "m1" }))
			.mockResolvedValueOnce(
				sseResponse([
					frame({ seq: 1, type: "turn-start", messageId: "m1" }),
					`id: 2\ndata: ${JSON.stringify({ seq: 2, type: "from-a-newer-server" })}\n\n`,
					frame({ seq: 3, type: "text-delta", messageId: "m1", text: "still here" }),
					frame({ seq: 4, type: "turn-end", messageId: "m1", reason: "stop" }),
				]),
			)

		render(<Harness />)
		await waitFor(() => expect(screen.getByTestId("ready").textContent).toBe("true"))
		await act(async () => {
			screen.getByText("send").click()
		})

		await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready"))
		assert.lengthOf(eventsRequests(), 1, "an unknown frame is not a reason to reconnect")
		assert.include(screen.getByTestId("text").textContent ?? "", "still here")
	})

	it("joins a payload split across several data: lines", async () => {
		tracedFetch
			.mockResolvedValueOnce(jsonResponse(emptyHistory))
			.mockResolvedValueOnce(jsonResponse({ cursor: 0, messageId: "m1" }))
			.mockResolvedValueOnce(
				sseResponse([
					frame({ seq: 1, type: "turn-start", messageId: "m1" }),
					// SSE allows this; reading only the first `data:` line silently truncated it.
					`id: 2\ndata: {"seq":2,"type":"text-delta","messageId":"m1",\ndata: "text":"wrapped"}\n\n`,
					frame({ seq: 3, type: "turn-end", messageId: "m1", reason: "stop" }),
				]),
			)

		render(<Harness />)
		await waitFor(() => expect(screen.getByTestId("ready").textContent).toBe("true"))
		await act(async () => {
			screen.getByText("send").click()
		})

		await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready"))
		assert.include(screen.getByTestId("text").textContent ?? "", "wrapped")
	})

	it("stops reconnecting once stop() is called", async () => {
		tracedFetch
			.mockResolvedValueOnce(jsonResponse(emptyHistory))
			.mockResolvedValueOnce(jsonResponse({ cursor: 0, messageId: "m1" }))
			// Closes without a turn-end, so the hook would otherwise reconnect forever.
			.mockResolvedValue(sseResponse([frame({ seq: 1, type: "turn-start", messageId: "m1" })]))

		render(<Harness />)
		await waitFor(() => expect(screen.getByTestId("ready").textContent).toBe("true"))
		await act(async () => {
			screen.getByText("send").click()
		})
		await waitFor(() => expect(eventsRequests().length).toBeGreaterThan(0))

		await act(async () => {
			screen.getByText("stop").click()
		})
		const afterStop = eventsRequests().length
		await new Promise((resolve) => setTimeout(resolve, 150))

		assert.equal(screen.getByTestId("status").textContent, "ready")
		assert.equal(eventsRequests().length, afterStop, "a stopped stream must not open another connection")
	})

	it("surfaces a 409 as a turn-in-flight message, not a raw status", async () => {
		tracedFetch
			.mockResolvedValueOnce(jsonResponse(emptyHistory))
			.mockResolvedValueOnce(new Response("{}", { status: 409 }))

		render(<Harness />)
		await waitFor(() => expect(screen.getByTestId("ready").textContent).toBe("true"))
		await act(async () => {
			screen.getByText("send").click()
		})

		await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready"))
		// The optimistic bubble is withdrawn along with the failure, so a retry can't duplicate it.
		assert.notInclude(screen.getByTestId("text").textContent ?? "", "hello")
	})

	it("renders an approval-gated call as proposed, not as a running tool", async () => {
		tracedFetch
			.mockResolvedValueOnce(jsonResponse(emptyHistory))
			.mockResolvedValueOnce(jsonResponse({ cursor: 0, messageId: "m1" }))
			.mockResolvedValueOnce(
				sseResponse([
					frame({ seq: 1, type: "turn-start", messageId: "m1" }),
					frame({
						seq: 2,
						type: "tool-call",
						messageId: "m1",
						callId: "c1",
						name: "create_alert_rule",
						input: {},
						proposed: true,
					}),
					frame({ seq: 3, type: "turn-end", messageId: "m1", reason: "stop" }),
				]),
			)

		render(<Harness />)
		await waitFor(() => expect(screen.getByTestId("ready").textContent).toBe("true"))
		await act(async () => {
			screen.getByText("send").click()
		})

		await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready"))
		// Was `[input-available]` — a spinner that never resolved, because the client waited for an
		// output the server never sends for a gated call.
		assert.include(screen.getByTestId("text").textContent ?? "", "[proposed]")
	})

	it("retracts the text of a retried step instead of showing it twice", async () => {
		tracedFetch
			.mockResolvedValueOnce(jsonResponse(emptyHistory))
			.mockResolvedValueOnce(jsonResponse({ cursor: 0, messageId: "m1" }))
			.mockResolvedValueOnce(
				sseResponse([
					frame({ seq: 1, type: "turn-start", messageId: "m1" }),
					frame({ seq: 2, type: "text-delta", messageId: "m1", text: "Hello wo" }),
					frame({
						seq: 3,
						type: "turn-retry",
						messageId: "m1",
						attempt: 2,
						retractChars: 8,
						reason: "Transport",
						delayMs: 1000,
					}),
					frame({ seq: 4, type: "text-delta", messageId: "m1", text: "Hello world." }),
					frame({ seq: 5, type: "turn-end", messageId: "m1", reason: "stop" }),
				]),
			)

		render(<Harness />)
		await waitFor(() => expect(screen.getByTestId("ready").textContent).toBe("true"))
		await act(async () => {
			screen.getByText("send").click()
		})

		await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready"))
		// The leading "hello" is the optimistic user message. Without the retraction the assistant's
		// half reads "Hello woHello world.".
		assert.equal(screen.getByTestId("text").textContent, "hello|Hello world.")
	})
})

describe("useMapleChat sub-agent transcripts", () => {
	const ref = { id: "t1", agent: "explore", parentMessageId: "m1" }

	it("nests a sub-agent's events under its task card, not the top-level thread", async () => {
		tracedFetch
			.mockResolvedValueOnce(jsonResponse(emptyHistory))
			.mockResolvedValueOnce(jsonResponse({ cursor: 0, messageId: "m1" }))
			.mockResolvedValueOnce(
				sseResponse([
					frame({ seq: 1, type: "turn-start", messageId: "m1" }),
					frame({
						seq: 2,
						type: "tool-call",
						messageId: "m1",
						callId: "t1",
						name: "task",
						input: { subagent_type: "explore", description: "trace checkout" },
					}),
					frame({ seq: 3, type: "turn-start", messageId: "c1", task: ref }),
					frame({ seq: 4, type: "text-delta", messageId: "c1", text: "child text", task: ref }),
					frame({ seq: 5, type: "turn-end", messageId: "c1", reason: "stop", task: ref }),
					frame({
						seq: 6,
						type: "tool-result",
						messageId: "m1",
						callId: "t1",
						output: "<task_result/>",
					}),
					frame({ seq: 7, type: "text-delta", messageId: "m1", text: "parent answer" }),
					frame({ seq: 8, type: "turn-end", messageId: "m1", reason: "stop" }),
				]),
			)

		render(<Harness />)
		await waitFor(() => expect(screen.getByTestId("ready").textContent).toBe("true"))
		await act(async () => {
			screen.getByText("send").click()
		})

		await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready"))
		// "child text" must NOT appear at the top level — it lives inside the task part. The harness
		// only renders top-level parts, so its absence here is the assertion.
		assert.equal(screen.getByTestId("text").textContent, "hello|[task:explore:completed]|parent answer")
	})
})
