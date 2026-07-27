// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import type { V2Investigation } from "@maple/domain/http/v2"
import { afterEach, describe, expect, it } from "vitest"

import {
	InvestigationStatusBadge,
	investigationKindLabel,
	investigationOriginLabel,
} from "./investigation-status"

afterEach(() => {
	cleanup()
})

const incidentSubject = (kind: "error" | "anomaly" | "alert"): V2Investigation["subject"] =>
	({ type: "incident", incident_kind: kind, incident_id: "einc_1", issue_id: null }) as never

/**
 * These labels exist because the wire values are enum tokens, and rendering them
 * with `capitalize` produced things like "Investigating" and "System" in columns
 * headed Status and Origin.
 */
describe("investigation vocabulary", () => {
	it("names each lifecycle state the way a person would", () => {
		// `investigating` is the one that matters: rendering the wire value put
		// "Investigating" in a Status column where every other row said a state.
		render(<InvestigationStatusBadge status="investigating" />)
		expect(screen.getByText("In progress")).toBeTruthy()
		cleanup()
		render(<InvestigationStatusBadge status="failed" />)
		expect(screen.getByText("Failed")).toBeTruthy()
	})

	it("says how it started in one word, so a table column can hold it", () => {
		expect(investigationOriginLabel("user")).toBe("Manual")
		expect(investigationOriginLabel("system")).toBe("Automatic")
	})

	it("calls a free-form investigation a question, not a kind of incident", () => {
		expect(investigationKindLabel({ type: "freeform" } as never)).toBe("Question")
		expect(investigationKindLabel(incidentSubject("error"))).toBe("Error")
		expect(investigationKindLabel(incidentSubject("anomaly"))).toBe("Anomaly")
		expect(investigationKindLabel(incidentSubject("alert"))).toBe("Alert")
	})
})
