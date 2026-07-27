// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ChatTranscript, findDiagnosisMessageId } from "./chat-transcript"
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
	readOnly: false,
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

		expect(screen.queryAllByLabelText("Copy message")).toHaveLength(1)
		expect(screen.queryAllByLabelText("Copy link to message")).toHaveLength(1)
		expect(document.querySelectorAll('[data-slot="message-footer"]')).toHaveLength(1)
	})

	it("omits the permalink action when the thread isn't shareable", () => {
		render(<ChatTranscript {...baseProps} messages={[message("m1", "assistant", "hello")]} />)

		expect(screen.queryByLabelText("Copy message")).toBeTruthy()
		expect(screen.queryByLabelText("Copy link to message")).toBeNull()
	})

	it("marks a read-only shared thread with a separator row", () => {
		render(<ChatTranscript {...baseProps} readOnly messages={[message("m1", "assistant", "hi")]} />)

		const marker = document.querySelector('[data-slot="marker"]') as HTMLElement | null
		expect(marker?.dataset.variant).toBe("separator")
		expect(marker?.textContent).toContain("read-only")
	})

	it("renders a preserved fallback diagnosis as its own row", () => {
		render(
			<ChatTranscript
				{...baseProps}
				messages={[]}
				fallbackDiagnosis={report as never}
			/>,
		)

		expect(items().map((el) => (el as HTMLElement).dataset.messageId)).toEqual([
			"__fallback-diagnosis",
		])
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
