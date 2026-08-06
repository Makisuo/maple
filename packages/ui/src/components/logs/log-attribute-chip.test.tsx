import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { LogAttributeChip } from "./log-attribute-chip"

vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }))

// Enough of the hover-card open delay to clear it in one advance.
const PAST_OPEN_DELAY = 500
const PAST_CLOSE_DELAY = 1_000

class NoopObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

/** Base UI's positioner mounts floating-ui's `autoUpdate`; jsdom has neither observer. */
function stubLayoutGlobals() {
	vi.stubGlobal("ResizeObserver", NoopObserver)
	vi.stubGlobal("IntersectionObserver", NoopObserver)
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: true,
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false,
	}))
}

function openCards(): NodeListOf<Element> {
	return document.querySelectorAll('[data-slot="hover-card-content"]')
}

/** The chip itself, by accessible name — the open card contains buttons too. */
function chipTrigger(pair: string): HTMLElement {
	return screen.getByRole("button", { name: `Copy ${pair}` })
}

/** Base UI's hover layer listens on both pointer and mouse events. Send both. */
async function hoverIn(element: Element) {
	await act(async () => {
		fireEvent.pointerEnter(element)
		fireEvent.mouseEnter(element)
		fireEvent.pointerMove(element)
	})
	await act(async () => {
		vi.advanceTimersByTime(PAST_OPEN_DELAY)
	})
}

async function hoverOut(element: Element) {
	await act(async () => {
		fireEvent.pointerLeave(element)
		fireEvent.mouseLeave(element)
	})
	await act(async () => {
		vi.advanceTimersByTime(PAST_CLOSE_DELAY)
	})
}

let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
	vi.useFakeTimers()
	stubLayoutGlobals()
	writeText = vi.fn().mockResolvedValue(undefined)
	Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

describe("LogAttributeChip", () => {
	it("renders nothing but the trigger until it is hovered", () => {
		render(<LogAttributeChip attrKey="http.method" value="GET" tone="info" />)

		expect(screen.getByRole("button")).toBeDefined()
		expect(openCards().length).toBe(0)
	})

	// The regression. Arming used to swap the bare <button> for a Base UI trigger,
	// remounting the DOM node; a node inserted under a cursor that has already moved
	// on never gets `pointerenter`, so it never gets `pointerleave` either and the
	// card was stranded open. Node identity is the cheapest way to pin that shut.
	it("keeps the same trigger DOM node when hover arms the card", async () => {
		render(<LogAttributeChip attrKey="http.method" value="GET" tone="info" />)
		const before = chipTrigger("http.method=GET")

		await hoverIn(before)

		expect(openCards().length).toBe(1)
		expect(chipTrigger("http.method=GET")).toBe(before)
	})

	it("closes the card when the pointer leaves", async () => {
		render(<LogAttributeChip attrKey="http.method" value="GET" tone="info" />)
		const button = chipTrigger("http.method=GET")

		await hoverIn(button)
		expect(openCards().length).toBe(1)

		await hoverOut(button)
		expect(openCards().length).toBe(0)
	})

	// The reported bug in miniature: sweeping a row used to strand one card per
	// chip the cursor brushed, because a stranded card had no way to close.
	it("never leaves more than one card open while sweeping across chips", async () => {
		render(
			<div>
				<LogAttributeChip attrKey="http.method" value="GET" tone="info" />
				<LogAttributeChip attrKey="http.status_code" value="503" tone="error" />
			</div>,
		)
		const first = chipTrigger("http.method=GET")
		const second = chipTrigger("http.status_code=503")

		await hoverIn(first)
		expect(openCards().length).toBe(1)

		await hoverOut(first)
		await hoverIn(second)

		expect(openCards().length).toBe(1)
		expect(document.body.textContent).toContain("503")
	})

	// A log row is keyed by its virtual index and a chip by its attribute name, so
	// scrolling swaps a different log's value into the very same chip instance
	// rather than remounting it. Open state must not survive that. This one is an
	// invariant guard rather than a repro: jsdom lets a synthesized `pointerleave`
	// land on a node the cursor never entered, which is precisely what a real
	// browser refuses to do, so it passes against the old code too.
	it("does not keep a card open when the virtualizer recycles it onto another log", async () => {
		const { rerender } = render(<LogAttributeChip attrKey="http.method" value="GET" tone="info" />)

		await hoverIn(chipTrigger("http.method=GET"))
		expect(openCards().length).toBe(1)

		await hoverOut(chipTrigger("http.method=GET"))
		await act(async () => {
			rerender(<LogAttributeChip attrKey="http.method" value="POST" tone="info" />)
		})

		expect(openCards().length).toBe(0)
		expect(chipTrigger("http.method=POST")).toBeDefined()
	})

	it("does not carry a native title alongside the hover card", () => {
		render(<LogAttributeChip attrKey="http.method" value="GET" tone="info" />)
		const button = screen.getByRole("button")

		expect(button.hasAttribute("title")).toBe(false)
		// The visible label truncates the value, so the accessible name is what
		// carries the full pair.
		expect(button.getAttribute("aria-label")).toBe("Copy http.method=GET")
	})

	it("names the chip with the untruncated value even when the label is clipped", () => {
		const long = "x".repeat(80)
		render(<LogAttributeChip attrKey="url.full" value={long} tone="muted" />)

		const button = screen.getByRole("button")
		expect(button.getAttribute("aria-label")).toBe(`Copy url.full=${long}`)
		expect(button.textContent).not.toContain(long)
	})

	it("copies the pair on click without bubbling to the row underneath", async () => {
		const rowClick = vi.fn()
		render(
			// eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
			<div onClick={rowClick}>
				<LogAttributeChip attrKey="http.method" value="GET" tone="info" />
			</div>,
		)

		await act(async () => {
			fireEvent.click(screen.getByRole("button"))
		})

		expect(writeText).toHaveBeenCalledWith("http.method=GET")
		// The chip is a copy affordance; clicking it must not also open the detail
		// sheet that the log row's own onClick opens.
		expect(rowClick).not.toHaveBeenCalled()
	})

	it("copies on Enter without bubbling", async () => {
		const rowClick = vi.fn()
		render(
			// eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
			<div onClick={rowClick}>
				<LogAttributeChip attrKey="http.method" value="GET" tone="info" />
			</div>,
		)

		await act(async () => {
			fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" })
		})

		expect(writeText).toHaveBeenCalledWith("http.method=GET")
		expect(rowClick).not.toHaveBeenCalled()
	})
})
