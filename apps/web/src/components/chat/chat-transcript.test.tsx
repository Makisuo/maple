// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ChatTranscript, findDiagnosisMessageId } from "./chat-transcript"
import { wrapChatContext } from "@maple/domain/chat-preamble"
import type { UIMessage } from "@/components/ai-elements/types"

afterEach(() => {
	cleanup()
})

/**
 * `MessageScroller` measures with ResizeObserver/IntersectionObserver, neither of which
 * jsdom implements. The transcript's structure doesn't depend on measurement, so no-op
 * stubs are enough to let it mount.
 */
class NoopObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopObserver)
vi.stubGlobal("IntersectionObserver", NoopObserver)

const message = (id: string, role: "user" | "assistant", text: string): UIMessage =>
	({ id, role, parts: [{ type: "text", text }] }) as unknown as UIMessage

const toolMessage = (id: string, output: unknown): UIMessage =>
	({
		id,
		role: "assistant",
		parts: [
			{
				type: "tool-diagnose_service",
				toolCallId: `${id}-call`,
				state: "output-available",
				input: { service: "api" },
				output,
			},
		],
	}) as unknown as UIMessage

const report = {
	summary: "Checkout is degraded",
	suspectedCause: "db pool exhausted",
	severityAssessment: "high",
	affectedScope: "checkout",
	evidence: [],
	suggestedActions: ["Raise the pool size"],
	confidence: "high",
} as const

const baseProps = {
	isLoading: false,
	resolvedApprovals: new Map<string, "applied" | "denied">(),
	onApprove: () => {},
	onDeny: () => {},
	fallbackDiagnosis: null,
	readOnly: false as const,
	emptyState: <p>Ask me anything</p>,
}

const items = () => [...document.querySelectorAll('[data-slot="message-scroller-item"]')]

describe("ChatTranscript", () => {
	it("renders the empty state instead of a scroller when there is nothing to scroll", () => {
		render(<ChatTranscript {...baseProps} messages={[]} />)

		expect(screen.getByText("Ask me anything")).toBeTruthy()
		expect(document.querySelector('[data-slot="message-scroller"]')).toBeNull()
	})

	it("gives every row a stable id and anchors user turns", () => {
		render(
			<ChatTranscript
				{...baseProps}
				messages={[message("m1", "user", "hi"), message("m2", "assistant", "hello")]}
			/>,
		)

		expect(items().map((el) => (el as HTMLElement).dataset.messageId)).toEqual(["m1", "m2"])
		expect(items().map((el) => (el as HTMLElement).dataset.scrollAnchor)).toEqual(["true", "false"])
	})

	it("opts every row out of the primitive's off-screen size containment", () => {
		render(<ChatTranscript {...baseProps} messages={[message("m1", "user", "hi")]} />)

		// Guards the CollapsiblePanel-class regression: size containment over content
		// that settles its height after mount clamps scrollTop every frame.
		expect(items()[0]?.className).toContain("[content-visibility:visible]")
	})

	it("styles user turns as end-aligned bubbles and assistant turns as ghost", () => {
		render(
			<ChatTranscript
				{...baseProps}
				messages={[message("m1", "user", "hi"), message("m2", "assistant", "hello")]}
			/>,
		)

		const bubbles = [...document.querySelectorAll('[data-slot="bubble"]')] as HTMLElement[]
		expect(bubbles.map((el) => el.dataset.variant)).toEqual(["secondary", "ghost"])
		expect(bubbles.map((el) => el.dataset.align)).toEqual(["end", "start"])

		const rows = [...document.querySelectorAll('[data-slot="message"]')] as HTMLElement[]
		expect(rows.map((el) => el.dataset.align)).toEqual(["end", "start"])
	})

	it("renders the working state as a status marker row, not a phantom assistant turn", () => {
		render(<ChatTranscript {...baseProps} isLoading messages={[message("m1", "user", "hi")]} />)

		const marker = document.querySelector('[data-slot="marker"]')
		expect(marker?.textContent).toContain("Thinking")
		expect(marker?.closest('[data-slot="message"]')).toBeNull()
		expect(items().map((el) => (el as HTMLElement).dataset.messageId)).toEqual(["m1", "__status"])
	})

	it("offers copy actions on assistant turns only", () => {
		render(
			<ChatTranscript
				{...baseProps}
				messages={[message("m1", "user", "hi"), message("m2", "assistant", "hello")]}
				permalinkFor={(id) => `https://maple.test/chat?shared=t&m=${id}`}
			/>,
		)

		// `CopyButton` composes its accessible name as `Copy ${label}`, and the
		// shared convention is a capitalized label ("Session ID", "API key", …) —
		// so these read "Copy Message" / "Copy Link to message" since the
		// one-CopyButton refactor replaced the hand-rolled buttons here.
		expect(screen.queryAllByLabelText("Copy Message")).toHaveLength(1)
		expect(screen.queryAllByLabelText("Copy Link to message")).toHaveLength(1)
		expect(document.querySelectorAll('[data-slot="message-footer"]')).toHaveLength(1)
	})

	it("omits the permalink action when the thread isn't shareable", () => {
		render(<ChatTranscript {...baseProps} messages={[message("m1", "assistant", "hello")]} />)

		expect(screen.queryByLabelText("Copy Message")).toBeTruthy()
		expect(screen.queryByLabelText("Copy Link to message")).toBeNull()
	})

	it("marks a read-only shared thread with a separator row", () => {
		render(
			<ChatTranscript {...baseProps} readOnly="shared" messages={[message("m1", "assistant", "hi")]} />,
		)

		const marker = document.querySelector('[data-slot="marker"]') as HTMLElement | null
		expect(marker?.dataset.variant).toBe("separator")
		expect(marker?.textContent).toContain("Shared conversation")
	})

	// A resolved investigation is read-only for a completely different reason than
	// a teammate's shared link, and saying "shared" there is just wrong.
	it("says a resolved investigation is resolved, not shared", () => {
		render(
			<ChatTranscript
				{...baseProps}
				readOnly="resolved"
				messages={[message("m1", "assistant", "hi")]}
			/>,
		)

		const marker = document.querySelector('[data-slot="marker"]') as HTMLElement | null
		expect(marker?.textContent).toContain("Investigation resolved")
		expect(marker?.textContent).not.toContain("Shared")
	})

	// An agent loop emits one message per round-trip; six of them used to read as six
	// identical `Used 2 tools` cards stacked down the page.
	it("collapses a run of tool-only turns into a single tool group", () => {
		const burst = (id: string): UIMessage =>
			({
				id,
				role: "assistant",
				parts: [0, 1].map((i) => ({
					type: "tool-list_services",
					toolCallId: `${id}-${i}`,
					state: "output-available",
					input: { service: "api" },
					output: { ok: true },
				})),
			}) as unknown as UIMessage

		render(
			<ChatTranscript
				{...baseProps}
				messages={[burst("m1"), burst("m2"), burst("m3")]}
				permalinkFor={(id) => `https://maple.test/chat?m=${id}`}
			/>,
		)

		expect(screen.getByText("Used 6 tools")).toBeTruthy()
		expect(items()).toHaveLength(1)
		// Nothing to copy, so no invisible hover-action row reserving height either.
		expect(document.querySelectorAll('[data-slot="message-footer"]')).toHaveLength(0)
	})

	it("renders a preserved fallback diagnosis as its own row", () => {
		render(<ChatTranscript {...baseProps} messages={[]} fallbackDiagnosis={report as never} />)

		expect(items().map((el) => (el as HTMLElement).dataset.messageId)).toEqual(["__fallback-diagnosis"])
	})
})

describe("findDiagnosisMessageId", () => {
	it("returns the id of the message carrying the report", () => {
		const messages = [
			message("m1", "user", "what broke?"),
			toolMessage("m2", { status: "diagnosis", report }),
		]
		expect(findDiagnosisMessageId(messages)).toBe("m2")
	})

	it("returns undefined for a thread with no report", () => {
		expect(findDiagnosisMessageId([message("m1", "assistant", "all good")])).toBeUndefined()
	})
})

describe("machine-written turns", () => {
	const fenced = (id: string, block: string, said = "") =>
		({
			id,
			role: "user",
			parts: [{ type: "text", text: wrapChatContext(block, said) }],
		}) as unknown as UIMessage

	// `apps/api` opens an investigation by sending a JSON snapshot as a user turn.
	// Now that user turns are durable it replays to every reader, and nobody typed it.
	it("renders a fully machine-written turn as a marker, not a bubble", () => {
		render(<ChatTranscript {...baseProps} messages={[fenced("m1", '{"subject":"…"}')]} />)

		const marker = document.querySelector('[data-slot="marker"]') as HTMLElement | null
		expect(marker?.textContent).toContain("Investigation started")
		expect(document.querySelector('[data-slot="bubble"]')).toBeNull()
	})

	it("keeps the person's own words and drops only the fenced context", () => {
		render(<ChatTranscript {...baseProps} messages={[fenced("m1", "subject: api", "Why is it slow?")]} />)

		expect(screen.getByText("Why is it slow?")).toBeTruthy()
		expect(screen.queryByText(/subject: api/)).toBeNull()
	})
})

describe("ChatTranscript sub-agent cards", () => {
	const taskMessage = (status: "running" | "completed" = "completed"): UIMessage =>
		({
			id: "m1",
			role: "assistant",
			parts: [
				{
					type: "task",
					toolCallId: "t1",
					agent: "explore",
					description: "trace checkout latency",
					status,
					messages: [
						{
							id: "c1",
							role: "assistant",
							parts: [{ type: "text", text: "p99 is 4.2s in checkout-api.", state: "done" }],
						},
					],
				},
			],
		}) as unknown as UIMessage

	it("renders a collapsed card naming the sub-agent and what it was asked", () => {
		render(<ChatTranscript {...baseProps} messages={[taskMessage()]} />)

		expect(screen.getByText("explore")).toBeTruthy()
		expect(screen.getByText("trace checkout latency")).toBeTruthy()
		// Collapsed by default: the point of delegating is that the parent thread does not carry
		// the sub-agent's search.
		expect(screen.queryByText("p99 is 4.2s in checkout-api.")).toBeNull()
	})

	it("expands to the sub-agent's own transcript on click", () => {
		render(<ChatTranscript {...baseProps} messages={[taskMessage()]} />)

		fireEvent.click(screen.getByText("explore"))
		expect(screen.getByText("p99 is 4.2s in checkout-api.")).toBeTruthy()
	})

	it("never folds a sub-agent into a Used N tools header", () => {
		// A sub-agent run is content, not plumbing.
		render(<ChatTranscript {...baseProps} messages={[taskMessage()]} />)

		expect(screen.queryByText(/Used \d+ tools/)).toBeNull()
		expect(items().map((el) => (el as HTMLElement).dataset.messageId)).toEqual(["m1"])
	})
})
