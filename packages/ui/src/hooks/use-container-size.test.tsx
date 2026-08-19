import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { useContainerSize } from "./use-container-size"

/**
 * jsdom ships no `ResizeObserver`, so the suite installs one it can drive. This is
 * a global stand-in for a missing DOM API, not a mock of the module under test —
 * the hook is exercised exactly as written.
 */
const observers: FakeResizeObserver[] = []

class FakeResizeObserver implements ResizeObserver {
	constructor(private readonly callback: ResizeObserverCallback) {
		observers.push(this)
	}
	observe() {}
	unobserve() {}
	disconnect() {}
	emit(entries: ResizeObserverEntry[]) {
		this.callback(entries, this)
	}
}

globalThis.ResizeObserver = FakeResizeObserver

afterEach(() => {
	observers.length = 0
})

function readOnlyRect(width: number, height: number): DOMRectReadOnly {
	return {
		x: 0,
		y: 0,
		width,
		height,
		top: 0,
		right: width,
		bottom: height,
		left: 0,
		toJSON: () => ({ width, height }),
	}
}

function entryFor(target: Element, width: number, height: number): ResizeObserverEntry {
	const size: ResizeObserverSize = { blockSize: height, inlineSize: width }
	return {
		target,
		contentRect: readOnlyRect(width, height),
		borderBoxSize: [size],
		contentBoxSize: [size],
		devicePixelContentBoxSize: [size],
	}
}

/** An element whose box the test dictates; jsdom lays nothing out on its own. */
function elementSized(width: number, height: number) {
	const el = document.createElement("div")
	el.getBoundingClientRect = () => readOnlyRect(width, height)
	return el
}

function mount(el: HTMLElement) {
	const ref: React.RefObject<HTMLElement | null> = { current: el }
	let renders = 0
	const hook = renderHook(() => {
		renders += 1
		return useContainerSize(ref)
	})
	return { hook, renderCount: () => renders }
}

function resizeTo(width: number, height: number, el: HTMLElement) {
	act(() => {
		for (const observer of observers) observer.emit([entryFor(el, width, height)])
	})
}

describe("useContainerSize", () => {
	it("reports whole pixels", () => {
		const el = elementSized(300.4, 200.6)
		const { hook } = mount(el)
		expect(hook.result.current).toEqual({ width: 300, height: 201 })
	})

	it("ignores a sub-pixel reflow that rounds to the same box", () => {
		// THE regression test. `containerWidth` is an input to the line and area
		// charts' `definition` memo, so a fresh object per ResizeObserver tick
		// rebuilt the whole chart scene during any sidebar animation or window drag.
		const el = elementSized(300.4, 200.6)
		const { hook, renderCount } = mount(el)
		const first = hook.result.current
		const rendersBefore = renderCount()

		resizeTo(300.2, 200.55, el)
		resizeTo(299.8, 200.6, el)
		resizeTo(300.4, 201.2, el)
		resizeTo(300.1, 200.9, el)

		// Same object, so every memo keyed on the measurement holds.
		expect(hook.result.current).toBe(first)
		// React may still render once before bailing out on an unchanged state, but
		// it must not be once PER TICK — that is the churn the rounding removes.
		expect(renderCount() - rendersBefore).toBeLessThanOrEqual(1)
	})

	it("still reports a real resize", () => {
		const el = elementSized(300.4, 200.6)
		const { hook } = mount(el)

		resizeTo(500.2, 400.8, el)

		expect(hook.result.current).toEqual({ width: 500, height: 401 })
	})
})
