import { describe, expect, it } from "vitest"
import { Schema } from "effect"

import {
	FUNNEL_EMPTY_GROUP_LABEL,
	ProductEventsFunnelWidgetParams,
	funnelWidgetBreakdownRows,
	funnelWidgetRows,
	type FunnelStep,
} from "./funnel"

const steps: ReadonlyArray<FunnelStep> = [
	{ kind: "page", pagePath: "/pricing" },
	{ kind: "event", eventName: "signup_completed" },
	{ kind: "event", eventName: "plan_started" },
]

describe("funnelWidgetRows", () => {
	it("labels one row per step in order and zero-fills missing steps", () => {
		expect(
			funnelWidgetRows(steps, [
				{ step: 1, count: 100 },
				{ step: 2, count: 40 },
			]),
		).toEqual([
			{ name: "/pricing", value: 100 },
			{ name: "signup_completed", value: 40 },
			{ name: "plan_started", value: 0 },
		])
	})
})

describe("funnelWidgetBreakdownRows", () => {
	it("emits every step per group, ranked by step-1 count, with the empty group labelled", () => {
		const rows = funnelWidgetBreakdownRows(steps, [
			{ group: "", step: 1, count: 5 },
			{ group: "", step: 2, count: 1 },
			{ group: "news.ycombinator.com", step: 1, count: 80 },
			{ group: "news.ycombinator.com", step: 2, count: 30 },
			{ group: "news.ycombinator.com", step: 3, count: 10 },
			{ group: "twitter.com", step: 1, count: 80 },
			{ group: "twitter.com", step: 2, count: 10 },
		])
		expect(rows.map((row) => row.group)).toEqual([
			"news.ycombinator.com",
			"news.ycombinator.com",
			"news.ycombinator.com",
			"twitter.com",
			"twitter.com",
			"twitter.com",
			FUNNEL_EMPTY_GROUP_LABEL,
			FUNNEL_EMPTY_GROUP_LABEL,
			FUNNEL_EMPTY_GROUP_LABEL,
		])
		expect(rows.filter((row) => row.group === "twitter.com").map((row) => row.value)).toEqual([80, 10, 0])
		expect(rows[0]).toEqual({ name: "/pricing", value: 80, group: "news.ycombinator.com" })
	})
})

describe("ProductEventsFunnelWidgetParams", () => {
	it("decodes the flat params bag a funnel widget stores", () => {
		const decoded = Schema.decodeSync(ProductEventsFunnelWidgetParams)({
			steps,
			keyBy: "visitor",
			breakdownBy: "attribute:plan",
			country: "DE",
			visitorType: "new",
		})
		expect(decoded.breakdownBy).toBe("attribute:plan")
		expect(decoded.country).toBe("DE")
		expect(decoded.windowSeconds).toBeUndefined()
	})
})
