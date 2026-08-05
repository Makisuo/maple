// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { buildAgentTraceModel } from "./agent-trace-model"
import { AgentTraceTimeBand } from "./agent-trace-header"

afterEach(cleanup)

describe("AgentTraceTimeBand", () => {
	/**
	 * The band's five ticks are a fixed positional array, so they key by index.
	 * Keying by label used to collide the moment two quarters rounded to the same
	 * string — every sub-4s agent trace, and all five ticks on a degenerate 1ms one.
	 */
	it("renders five ticks on an agent trace too short for them to have distinct labels", () => {
		const warn = vi.spyOn(console, "error").mockImplementation(() => {})
		const model = buildAgentTraceModel([], null)
		expect(model.totalMs).toBeLessThanOrEqual(1)

		const { container } = render(<AgentTraceTimeBand model={model} running={false} />)

		const ticks = container.querySelectorAll("div.tabular-nums > span")
		expect(ticks.length).toBe(5)
		expect(Array.from(ticks, (tick) => tick.textContent)).toEqual(["0s", "0s", "0s", "0s", "0s"])
		expect(warn.mock.calls.flat().join(" ")).not.toMatch(/same key|duplicate key/i)
		warn.mockRestore()
	})
})
