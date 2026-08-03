import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useDebouncedCallback } from "./use-debounced-callback"

describe("useDebouncedCallback", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("fires once with the last call's arguments", () => {
		const fn = vi.fn()
		const { result } = renderHook(() => useDebouncedCallback(fn, 300))

		act(() => {
			result.current("a")
			result.current("b")
			result.current("c")
		})
		expect(fn).not.toHaveBeenCalled()

		act(() => {
			vi.advanceTimersByTime(300)
		})
		expect(fn).toHaveBeenCalledTimes(1)
		expect(fn).toHaveBeenCalledWith("c")
	})

	it("cancel() drops the pending invocation", () => {
		const fn = vi.fn()
		const { result } = renderHook(() => useDebouncedCallback(fn, 300))

		act(() => {
			result.current("a")
			result.current.cancel()
			vi.advanceTimersByTime(1000)
		})
		expect(fn).not.toHaveBeenCalled()
	})

	it("does not fire after unmount", () => {
		const fn = vi.fn()
		const { result, unmount } = renderHook(() => useDebouncedCallback(fn, 300))

		act(() => {
			result.current("a")
		})
		unmount()
		act(() => {
			vi.advanceTimersByTime(1000)
		})
		expect(fn).not.toHaveBeenCalled()
	})

	it("keeps a stable identity while always calling the latest fn", () => {
		let calls: string[] = []
		const { result, rerender } = renderHook(
			({ tag }) => useDebouncedCallback(() => calls.push(tag), 100),
			{
				initialProps: { tag: "first" },
			},
		)
		const initial = result.current

		rerender({ tag: "second" })
		expect(result.current).toBe(initial)

		act(() => {
			result.current()
			vi.advanceTimersByTime(100)
		})
		expect(calls).toEqual(["second"])
	})
})
