import { describe, expect, it } from "vitest"
import type { V2ScrapeTargetCheck } from "@maple/domain/http/v2"
import { scheduledStatusFromChecks, scheduledStatusFromRollup } from "./scrape-target-status"

const successfulCheck: V2ScrapeTargetCheck = {
	object: "scrape_target.check",
	timestamp: "2026-07-18T10:00:00.000Z",
	success: true,
	sub_target_key: null,
	duration_seconds: 0.4,
	samples_scraped: 100,
	samples_post_metric_relabeling: 100,
	message: null,
}

describe("scheduledStatusFromRollup", () => {
	it("reports disabled, never-scraped, healthy, and failed targets", () => {
		expect(
			scheduledStatusFromRollup({ enabled: false, last_scrape_at: null, last_scrape_error: null }),
		).toMatchObject({ label: "Disabled", badgeVariant: "outline" })
		expect(
			scheduledStatusFromRollup({ enabled: true, last_scrape_at: null, last_scrape_error: null }),
		).toMatchObject({ label: "No checks", badgeVariant: "warning" })
		expect(
			scheduledStatusFromRollup({
				enabled: true,
				last_scrape_at: "2026-07-18T10:00:00.000Z",
				last_scrape_error: null,
			}),
		).toMatchObject({ label: "Up", badgeVariant: "success" })
		expect(
			scheduledStatusFromRollup({
				enabled: true,
				last_scrape_at: "2026-07-18T10:00:00.000Z",
				last_scrape_error: "connection refused",
			}),
		).toMatchObject({ label: "Down", badgeVariant: "error" })
	})
})

describe("scheduledStatusFromChecks", () => {
	it("distinguishes loading, unavailable, healthy, and failed history", () => {
		expect(scheduledStatusFromChecks({ enabled: true }, null, true, false)).toMatchObject({
			label: "Checking",
		})
		expect(scheduledStatusFromChecks({ enabled: true }, null, false, true)).toMatchObject({
			label: "Unavailable",
		})
		expect(scheduledStatusFromChecks({ enabled: true }, successfulCheck, false, false)).toMatchObject({
			label: "Up",
		})
		expect(
			scheduledStatusFromChecks(
				{ enabled: true },
				{ ...successfulCheck, success: false, message: "timeout" },
				false,
				false,
			),
		).toMatchObject({ label: "Down", badgeVariant: "error" })
	})
})
