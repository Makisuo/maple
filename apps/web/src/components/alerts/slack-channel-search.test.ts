import { describe, expect, it } from "vitest"
import {
	CHANNEL_RESULT_LIMIT,
	channelLabel,
	channelPickerView,
	rankChannels,
	resolveSearchQuery,
	scoreChannelName,
} from "./slack-channel-search"

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
		// Both are prefix matches and neither is exact — otherwise this would be
		// comparing tiers (exact > prefix) and prove nothing about length.
		expect(scoreChannelName("dep-a", "dep")).toBeGreaterThan(
			scoreChannelName("dep-a-very-long", "dep")!,
		)
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

const pickable = (id: string, name: string, is_private = false, is_member = true) => ({
	id,
	name,
	is_private,
	is_member,
})

describe("resolveSearchQuery", () => {
	const publicChannel = pickable("C1", "alerts")
	const privateChannel = pickable("C2", "alerts", true)

	it("treats the rendered label of the selected channel as 'not a search'", () => {
		expect(resolveSearchQuery(channelLabel(publicChannel), publicChannel)).toBe("")
		// The regression: a private channel's label carries " (private)", so a
		// bare-name compare left the query set and emptied the picker.
		expect(channelLabel(privateChannel)).toBe("#alerts (private)")
		expect(resolveSearchQuery(channelLabel(privateChannel), privateChannel)).toBe("")
	})

	it("also accepts the plain #name / name forms of the selection", () => {
		expect(resolveSearchQuery("#alerts", privateChannel)).toBe("")
		expect(resolveSearchQuery("alerts", privateChannel)).toBe("")
		expect(resolveSearchQuery("  #Alerts (PRIVATE) ", privateChannel)).toBe("")
	})

	it("leaves real typing alone", () => {
		expect(resolveSearchQuery("dep", publicChannel)).toBe("dep")
		expect(resolveSearchQuery("alerts-2", publicChannel)).toBe("alerts-2")
		expect(resolveSearchQuery("alerts", undefined)).toBe("alerts")
	})
})

describe("channelPickerView", () => {
	const many = (count: number) => Array.from({ length: count }, (_, i) => pickable(`C${i}`, `chan-${i}`))

	it("does not claim truncation when a query merely narrows the list", () => {
		const channels = [...many(60)]
		// 60 channels, 3 matches — the old `visible.length < channels.length` check
		// reported "showing the closest 50 of 60".
		const view = channelPickerView(channels, "chan-1", null, 50)
		expect(view.truncated).toBe(false)
		expect(view.visible.length).toBeLessThan(50)
	})

	it("does not claim truncation when the match count exactly equals the cap", () => {
		const view = channelPickerView(many(50), "", null, 50)
		expect(view.visible.length).toBe(50)
		expect(view.truncated).toBe(false)
	})

	it("claims truncation only once matches were actually dropped", () => {
		const view = channelPickerView(many(51), "", null, 50)
		expect(view.visible.length).toBe(50)
		expect(view.truncated).toBe(true)
	})

	it("never reports truncation with nothing to show", () => {
		const view = channelPickerView(many(500), "zzqqzz", null, CHANNEL_RESULT_LIMIT)
		expect(view.visible).toEqual([])
		expect(view.truncated).toBe(false)
	})

	it("pulls the selected channel into the unfiltered view even when it's past the cap", () => {
		const channels = many(500)
		const selected = channels.at(-1)!
		const view = channelPickerView(channels, "", selected.id, 50)
		expect(view.visible.length).toBe(50)
		expect(view.visible[0]).toBe(selected)
		expect(view.truncated).toBe(true)
	})

	it("leaves a filtered view honest — the selection is not forced into search results", () => {
		const channels = [...many(60), pickable("C-sel", "totally-unrelated")]
		const view = channelPickerView(channels, "chan-1", "C-sel", 50)
		expect(view.visible.some((c) => c.id === "C-sel")).toBe(false)
	})

	it("doesn't duplicate a selection that already ranks", () => {
		const channels = many(10)
		const view = channelPickerView(channels, "", "C3", 50)
		expect(view.visible.filter((c) => c.id === "C3").length).toBe(1)
		expect(view.visible.length).toBe(10)
	})
})
