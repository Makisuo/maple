import { describe, expect, it } from "vitest"
import { splitReleaseIssues, type ReleaseIssueDates } from "./release-issues-panel"

// Only the fields the split reads; the document's other thirty are irrelevant here.
function issue(fields: {
	id: string
	firstSeenAt: string
	lastRegressedAt?: string | null
}): ReleaseIssueDates & { id: string } {
	return {
		id: fields.id,
		firstSeenAt: fields.firstSeenAt,
		lastRegressedAt: fields.lastRegressedAt ?? null,
	}
}

const RELEASE_FIRST_SEEN = "2026-09-05T09:41:00.000Z"

describe("splitReleaseIssues", () => {
	it("splits by first-seen against the release, with slack for bucket flooring", () => {
		const split = splitReleaseIssues(
			[
				issue({ id: "fresh", firstSeenAt: "2026-09-05T09:44:00.000Z" }),
				issue({ id: "slack", firstSeenAt: "2026-09-05T09:37:00.000Z" }),
				issue({
					id: "regressed",
					firstSeenAt: "2026-08-01T00:00:00.000Z",
					lastRegressedAt: "2026-09-05T10:00:00.000Z",
				}),
				issue({
					id: "old-regression",
					firstSeenAt: "2026-08-01T00:00:00.000Z",
					lastRegressedAt: "2026-08-20T00:00:00.000Z",
				}),
				issue({ id: "ongoing", firstSeenAt: "2026-08-01T00:00:00.000Z" }),
			],
			RELEASE_FIRST_SEEN,
		)
		expect(split.fresh.map((i) => i.id)).toEqual(["fresh", "slack"])
		expect(split.regressed.map((i) => i.id)).toEqual(["regressed"])
		expect(split.ongoing.map((i) => i.id)).toEqual(["old-regression", "ongoing"])
	})
})
