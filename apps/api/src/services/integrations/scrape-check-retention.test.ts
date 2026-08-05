import { assert, describe, it } from "@effect/vitest"
import { canExceedRowCap, type RetentionTarget } from "@/services/integrations/scrape-check-retention"

const target = (overrides: Partial<RetentionTarget> = {}): RetentionTarget => ({
	id: "tgt_1",
	targetType: "prometheus",
	scrapeIntervalSeconds: 15,
	...overrides,
})

describe("canExceedRowCap", () => {
	it("skips ordinary targets whose interval cannot fill the cap in 24h", () => {
		// 86400/15 = 5,760 rows a day, well under the 10k cap.
		assert.isFalse(canExceedRowCap(target()))
		assert.isFalse(canExceedRowCap(target({ scrapeIntervalSeconds: 30 })))
		// 86400/9 = 9,600 — still under.
		assert.isFalse(canExceedRowCap(target({ scrapeIntervalSeconds: 9 })))
	})

	it("probes targets fast enough to reach the cap within the retention window", () => {
		// 86400/8 = 10,800 rows a day, over the cap.
		assert.isTrue(canExceedRowCap(target({ scrapeIntervalSeconds: 8 })))
		assert.isTrue(canExceedRowCap(target({ scrapeIntervalSeconds: 1 })))
	})

	it("always probes planetscale targets — sub-target fan-out is not derivable from the interval", () => {
		assert.isTrue(canExceedRowCap(target({ targetType: "planetscale", scrapeIntervalSeconds: 60 })))
	})

	it("probes rather than skips when the interval is missing or nonsensical", () => {
		assert.isTrue(canExceedRowCap(target({ scrapeIntervalSeconds: 0 })))
		assert.isTrue(canExceedRowCap(target({ scrapeIntervalSeconds: -1 })))
	})
})
