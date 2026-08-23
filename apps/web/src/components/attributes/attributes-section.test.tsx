// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { AttributesSection } from "@/components/attributes"

afterEach(() => {
	cleanup()
})

/**
 * The gateway stamps `maple_*` keys on spans as well as resources (`maple_ai.*`
 * since the AI-session work), so the "Maple Internal" fold has to key off the
 * prefix wherever an attribute map is rendered — not off which map it is.
 */
describe("AttributesSection", () => {
	it("folds maple_ keys out of the main table into Maple Internal", () => {
		render(
			<AttributesSection
				title="Span Attributes"
				attributes={{
					"http.request.method": "GET",
					"maple_ai.vendor.id": "anthropic",
					"maple_ai.session.id": "sess_123",
				}}
			/>,
		)

		expect(screen.getByText("Maple Internal (2)")).toBeTruthy()
		// Collapsed by default: the internal keys are not in the open table.
		expect(screen.queryByText("maple_ai.vendor.id")).toBeNull()
		expect(screen.getByText("http.request.method")).toBeTruthy()
	})

	it("lifts gen_ai keys into the AI block instead of the raw table", () => {
		render(
			<AttributesSection
				title="Span Attributes"
				attributes={{ "gen_ai.usage.input_tokens": "178", "http.route": "/v1" }}
			/>,
		)

		expect(screen.getByText("AI Attributes")).toBeTruthy()
		expect(screen.getByText("Input")).toBeTruthy()
		// The key column is the label now; the key itself is only the copy payload.
		expect(screen.queryByText("gen_ai.usage.input_tokens")).toBeNull()
		expect(screen.getByText("http.route")).toBeTruthy()
	})

	it("renders no fold when nothing is internal", () => {
		render(<AttributesSection title="Span Attributes" attributes={{ "http.route": "/v1" }} />)

		expect(screen.queryByText(/Maple Internal/)).toBeNull()
	})
})
