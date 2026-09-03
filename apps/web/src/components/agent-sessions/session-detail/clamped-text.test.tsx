// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { ClampedText, previewOf } from "./clamped-text"

afterEach(cleanup)

const lines = (count: number, prefix = "line") => Array.from({ length: count }, (_, i) => `${prefix} ${i}`)

describe("previewOf", () => {
	it("returns a short body whole", () => {
		const text = lines(40).join("\n")
		expect(previewOf(text)).toBe(text)
	})

	it("cuts a long body at a line boundary", () => {
		const preview = previewOf(lines(500).join("\n"))
		expect(preview.split("\n")).toHaveLength(72)
		expect(preview.endsWith("line 71")).toBe(true)
	})

	it("cuts one endless line by length", () => {
		expect(previewOf("x".repeat(50_000))).toHaveLength(8_000)
	})
})

describe("ClampedText", () => {
	it("mounts a long body as a preview, and the whole of it once opened", () => {
		render(<ClampedText text={lines(1_000, "row").join("\n")} />)
		expect(screen.queryByText(/row 999/)).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Show full" }))
		expect(screen.getByText(/row 999/)).toBeDefined()
		expect(screen.getByRole("button", { name: "Show less" })).toBeDefined()
	})

	it("knows a verbatim body overruns its clamp without measuring it", () => {
		// jsdom lays nothing out, so a control here can only come from the count.
		render(<ClampedText text={lines(20).join("\n")} clampLines={12} />)
		expect(screen.getByRole("button", { name: "Show full" })).toBeDefined()
	})

	it("grows no control for a body that fits", () => {
		render(<ClampedText text={"one\ntwo"} />)
		expect(screen.queryByRole("button")).toBeNull()
	})

	it("highlights only the preview as JSON", () => {
		const json = JSON.stringify(
			Array.from({ length: 2_000 }, (_, i) => ({ i })),
			null,
			2,
		)
		const { container } = render(<ClampedText text={json} rendering="json" />)
		expect(container.querySelectorAll(".sh__line")).toHaveLength(72)
	})
})
