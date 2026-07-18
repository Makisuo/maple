// @vitest-environment jsdom

import type { V2ScrapeTargetCheck } from "@maple/domain/http/v2"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Result } from "@/lib/effect-atom"
import { ScrapeTargetChecksTable } from "./scrape-targets-section"

const check = (
	timestamp: string,
	message: string | null,
	overrides: Partial<V2ScrapeTargetCheck> = {},
): V2ScrapeTargetCheck => ({
	object: "scrape_target.check",
	timestamp,
	success: message === null,
	sub_target_key: null,
	duration_seconds: 0.25,
	samples_scraped: 42,
	samples_post_metric_relabeling: 42,
	message,
	...overrides,
})

afterEach(cleanup)

describe("ScrapeTargetChecksTable", () => {
	it("renders loading, error, and empty history states", () => {
		const view = render(<ScrapeTargetChecksTable result={Result.initial()} checks={[]} />)
		expect(view.container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3)

		view.rerender(<ScrapeTargetChecksTable result={Result.fail(new Error("unavailable"))} checks={[]} />)
		expect(screen.getByText("Failed to load scheduled checks.")).toBeTruthy()

		view.rerender(<ScrapeTargetChecksTable result={Result.success({ checks: [] })} checks={[]} />)
		expect(screen.getByText("No scheduled checks recorded yet.")).toBeTruthy()
	})

	it("preserves newest-first API order and renders v2 snake-case fields", () => {
		const checks = [
			check("2026-07-18T10:00:00.000Z", "newest failure", {
				duration_seconds: 1.5,
				samples_scraped: 12,
			}),
			check("2026-07-18T09:00:00.000Z", "older failure"),
		]
		render(<ScrapeTargetChecksTable result={Result.success({ checks })} checks={checks} />)

		const newest = screen.getByText("newest failure")
		const older = screen.getByText("older failure")
		expect(newest.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
		expect(screen.getByText("1.50s")).toBeTruthy()
		expect(screen.getByText("12")).toBeTruthy()
	})
})
