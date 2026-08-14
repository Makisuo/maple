// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { SessionEvent } from "../events-sink"
import { startBaselineCapture } from "./baseline"

describe("startBaselineCapture", () => {
	let events: SessionEvent[]
	let stop: (() => void) | undefined

	beforeEach(() => {
		events = []
	})
	afterEach(() => {
		stop?.()
		stop = undefined
	})

	const start = (maskAllText = false): void => {
		stop = startBaselineCapture((ev) => events.push(ev), maskAllText)
	}

	it("captures clicks with a selector", () => {
		start()
		const button = document.createElement("button")
		button.id = "save"
		button.textContent = "Save changes"
		document.body.appendChild(button)
		button.click()

		expect(events).toHaveLength(1)
		expect(events[0]?.type).toBe("click")
		expect(events[0]?.targetSelector).toBe("button#save")
		expect(events[0]?.targetText).toBe("Save changes")
	})

	it("omits click target text when maskAllText is set", () => {
		start(true)
		const button = document.createElement("button")
		button.textContent = "user@example.com"
		document.body.appendChild(button)
		button.click()

		expect(events[0]?.targetText).toBeUndefined()
	})

	it("captures uncaught errors as error-level events", () => {
		start()
		window.dispatchEvent(new ErrorEvent("error", { message: "boom" }))

		expect(events).toHaveLength(1)
		expect(events[0]?.type).toBe("error")
		expect(events[0]?.level).toBe("error")
		expect(events[0]?.message).toBe("boom")
	})

	it("never records input values, only that an input happened", () => {
		start()
		const input = document.createElement("input")
		document.body.appendChild(input)
		input.value = "hunter2"
		input.dispatchEvent(new Event("input", { bubbles: true }))

		expect(events).toHaveLength(1)
		expect(events[0]?.type).toBe("input")
		expect(JSON.stringify(events[0])).not.toContain("hunter2")
	})

	it("removes every listener it installed on stop", () => {
		start()
		stop?.()
		stop = undefined

		const button = document.createElement("button")
		document.body.appendChild(button)
		button.click()
		window.dispatchEvent(new ErrorEvent("error", { message: "boom" }))

		expect(events).toEqual([])
	})

	it("never throws into the host app when the sink does", () => {
		stop = startBaselineCapture(() => {
			throw new Error("sink exploded")
		}, false)
		const button = document.createElement("button")
		document.body.appendChild(button)

		expect(() => button.click()).not.toThrow()
	})

	// The no-DOM guard is covered by every other suite in this package: they run
	// under `node`, and `startEventSink` calls straight into here.
})
