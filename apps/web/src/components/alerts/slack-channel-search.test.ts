import { describe, expect, it } from "vitest"
import { CHANNEL_RESULT_LIMIT, rankChannels, scoreChannelName } from "./slack-channel-search"

const channel = (name: string, is_member = true) => ({ name, is_member })
const names = (list: ReadonlyArray<{ name: string }>) => list.map((c) => c.name)

describe("scoreChannelName", () => {
	it("orders exact > prefix > word-boundary > substring > subsequence", () => {
		const scores = [
			scoreChannelName("alerts", "alerts"),
			scoreChannelName("alerts-prod", "alerts"),
			scoreChannelName("deploy-alerts", "alerts"),
			scoreChannelName("stalerts", "alerts"),
			scoreChannelName("a-long-eventful-run-tests", "alerts"),
		] as Array<number>
		expect(scores.every((s) => s !== null)).toBe(true)
		for (let i = 1; i < scores.length; i++) expect(scores[i]!).toBeLessThan(scores[i - 1]!)
	})

	it("ignores a typed # and is case-insensitive", () => {
		expect(scoreChannelName("General", "#gen")).toBe(scoreChannelName("general", "GEN"))
		expect(scoreChannelName("general", "#general")).toBe(scoreChannelName("general", "general"))
	})

	it("returns null when the characters aren't all present in order", () => {
		expect(scoreChannelName("deploy-alerts", "zzz")).toBeNull()
		// Right characters, wrong order — subsequence is ordered on purpose.
		expect(scoreChannelName("alerts", "strela")).toBeNull()
	})

	it("scores an empty query as a neutral match rather than no match", () => {
		expect(scoreChannelName("anything", "")).toBe(0)
		expect(scoreChannelName("anything", "  ")).toBe(0)
	})

	it("prefers the shorter name among prefix matches", () => {
		expect(scoreChannelName("dep", "dep")).toBeGreaterThan(scoreChannelName("dep-a-very-long", "dep")!)
	})
})

describe("rankChannels", () => {
	it("puts a fuzzy typo's intended channel first", () => {
		const channels = [
			channel("random"),
			channel("design-eng"),
			channel("deploy-alerts"),
			channel("deploys"),
		]
		expect(names(rankChannels(channels, "depaler"))[0]).toBe("deploy-alerts")
	})

	it("shows member channels first, then alphabetical, when the query is empty", () => {
		const channels = [channel("zulu"), channel("beta", false), channel("alpha", false), channel("mike")]
		expect(names(rankChannels(channels, ""))).toEqual(["mike", "zulu", "alpha", "beta"])
	})

	it("caps the result count", () => {
		const channels = Array.from({ length: 500 }, (_, i) => channel(`chan-${i}`))
		expect(rankChannels(channels, "").length).toBe(CHANNEL_RESULT_LIMIT)
		expect(rankChannels(channels, "chan").length).toBe(CHANNEL_RESULT_LIMIT)
		expect(rankChannels(channels, "chan", 5).length).toBe(5)
	})

	it("drops non-matching channels entirely", () => {
		const channels = [channel("alerts"), channel("random"), channel("deploys")]
		expect(names(rankChannels(channels, "alert"))).toEqual(["alerts"])
		expect(rankChannels(channels, "qqqq")).toEqual([])
	})

	it("ranks a private/non-member channel by relevance, not membership, when searching", () => {
		// Membership is only the tie-breaker — a much better name match wins.
		const channels = [channel("alerts-archive"), channel("alerts", false)]
		expect(names(rankChannels(channels, "alerts"))[0]).toBe("alerts")
	})
})
