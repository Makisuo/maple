import { describe, expect, it } from "vitest"
import type {
	BillingBalance,
	BillingCustomer,
	BillingSubscription,
	BillingUsage,
	CatalogPlan,
	DailySpendResponse,
} from "@maple/domain/http"
import { buildCumulativeSeries, buildSpendModel } from "./spend"

// Mock builders construct only the consumed subset of each domain schema, the
// same approach cost-estimate.test.ts takes.
const CYCLE_START = Date.UTC(2026, 6, 1)
const CYCLE_END = Date.UTC(2026, 7, 1)
const NOW = Date.UTC(2026, 6, 29, 12)

const startupPlan = {
	id: "startup",
	name: "Startup",
	price: { amount: 39, interval: "month" },
	items: [
		{ featureId: "logs", included: 100, price: { amount: 0.3 } },
		{ featureId: "traces", included: 100, price: { amount: 0.3 } },
		{ featureId: "metrics", included: 100, price: { amount: 0.3 } },
		{ featureId: "browser_sessions", included: 5_000, price: { amount: 0.002 } },
	],
} as unknown as CatalogPlan

const buildCustomer = (
	overrides: {
		subscriptions?: Partial<BillingSubscription>[]
		balances?: Record<string, Partial<BillingBalance>>
	} = {},
): BillingCustomer =>
	({
		id: "cus_1",
		subscriptions: overrides.subscriptions ?? [
			{
				planId: "startup",
				status: "active",
				addOn: false,
				currentPeriodStart: CYCLE_START,
				currentPeriodEnd: CYCLE_END,
			},
		],
		balances: overrides.balances ?? {
			logs: { granted: 100 },
			traces: { granted: 100 },
			metrics: { granted: 100 },
			browser_sessions: { granted: 5_000 },
		},
	}) as unknown as BillingCustomer

const usage = {
	logs: { sum: 390 },
	traces: { sum: 140 },
	metrics: { sum: 160 },
	browser_sessions: { sum: 26_700 },
} as unknown as BillingUsage["total"]

const model = () => buildSpendModel({ customer: buildCustomer(), plans: [startupPlan], usage, nowMs: NOW })

describe("buildSpendModel", () => {
	it("prices base + overage and projects to cycle end", () => {
		const result = model()
		if (result === null) throw new Error("expected a model")

		expect(result.baseCents).toBe(3_900)
		expect(result.overageCents).toBe(16_040)
		expect(result.spendCents).toBe(19_940)
		// Overage extrapolates on elapsed time (28.5 of 31 days at noon on the
		// 29th), the base fee stays flat. Fractional elapsed on purpose: rounding
		// to whole days makes the projection jump at midnight.
		expect(result.projectedCents).toBe(21_347)
		expect(result.dayOfCycle).toBe(29)
		expect(result.cycleDays).toBe(31)
		expect(result.planName).toBe("Startup")
	})

	it("names the top cost driver by overage dollars, not by volume", () => {
		const result = model()
		if (result === null) throw new Error("expected a model")

		// Sessions ingest 26,700 units vs logs' 390 GB, but logs cost more.
		expect(result.topDriver?.featureId).toBe("logs")
		expect(result.topDriver?.overageCents).toBe(8_700)
	})

	it("has no top driver while everything is within its allotment", () => {
		const result = buildSpendModel({
			customer: buildCustomer(),
			plans: [startupPlan],
			usage: { logs: { sum: 10 } } as unknown as BillingUsage["total"],
			nowMs: NOW,
		})
		expect(result?.topDriver).toBeNull()
		expect(result?.spendCents).toBe(3_900)
	})

	it("adds an active add-on to the base fee", () => {
		const byoc = {
			id: "bringyourowncloud",
			name: "Bring Your Own Cloud",
			addOn: true,
			price: { amount: 99 },
			items: [],
		} as unknown as CatalogPlan

		const result = buildSpendModel({
			customer: buildCustomer({
				subscriptions: [
					{
						planId: "startup",
						status: "active",
						addOn: false,
						currentPeriodStart: CYCLE_START,
						currentPeriodEnd: CYCLE_END,
					},
					{ planId: "bringyourowncloud", status: "active", addOn: true },
				],
			}),
			plans: [startupPlan, byoc],
			usage,
			nowMs: NOW,
		})

		expect(result?.baseCents).toBe(13_800)
		expect(result?.addOns.map((plan) => plan.id)).toEqual(["bringyourowncloud"])
	})

	it("marks a legacy plan absent from the catalog as partial", () => {
		const result = buildSpendModel({
			customer: buildCustomer({
				subscriptions: [{ planId: "legacy_pro", status: "active", addOn: false }],
			}),
			plans: [startupPlan],
			usage,
			nowMs: NOW,
		})
		expect(result?.partial).toBe(true)
	})

	it("falls back to the calendar month with no active subscription", () => {
		const result = buildSpendModel({
			customer: buildCustomer({ subscriptions: [] }),
			plans: [startupPlan],
			usage,
			nowMs: NOW,
		})
		expect(result?.cycle.startMs).toBe(Date.UTC(2026, 6, 1))
		expect(result?.baseCents).toBe(0)
	})
})

describe("buildCumulativeSeries", () => {
	const daily = (days: ReadonlyArray<{ date: string; logsGB: number }>): DailySpendResponse =>
		({
			days: days.map((day) => ({
				date: day.date,
				logsGB: day.logsGB,
				tracesGB: 0,
				metricsGB: 0,
				browserSessions: 0,
			})),
			cycleStart: CYCLE_START,
			cycleEnd: CYCLE_END,
		}) as unknown as DailySpendResponse

	// A model whose metered logs total equals the series' own sum, so these tests
	// exercise the accrual walk itself rather than the scaling above it.
	const unscaledModel = (loggedGB: number) => {
		const result = buildSpendModel({
			customer: buildCustomer(),
			plans: [startupPlan],
			usage: { logs: { sum: loggedGB } } as unknown as BillingUsage["total"],
			nowMs: NOW,
		})
		if (result === null) throw new Error("expected a model")
		return result
	}

	it("accrues overage only after the included allotment is crossed", () => {
		const spendModel = unscaledModel(180)

		// 60 GB/day against a 100 GB allotment: day 1 is fully included, day 2
		// crosses at 120 GB (20 GB over = $6), day 3 adds another 60 GB ($18).
		const series = buildCumulativeSeries({
			daily: daily([
				{ date: "2026-07-01", logsGB: 60 },
				{ date: "2026-07-02", logsGB: 60 },
				{ date: "2026-07-03", logsGB: 60 },
			]),
			model: spendModel,
		})

		expect(series.map((point) => point.logs)).toEqual([0, 6, 24])
		// The base fee is owed on day 1, so it's a flat band, never a slope.
		expect(series.map((point) => point.base)).toEqual([39, 39, 39])
		expect(series[2]?.total).toBe(63)
	})

	it("is monotonic — a zero-ingest day holds the line flat instead of dipping", () => {
		const spendModel = unscaledModel(200)

		const series = buildCumulativeSeries({
			daily: daily([
				{ date: "2026-07-01", logsGB: 150 },
				{ date: "2026-07-02", logsGB: 0 },
				{ date: "2026-07-03", logsGB: 50 },
			]),
			model: spendModel,
		})

		expect(series.map((point) => point.logs)).toEqual([15, 15, 30])
	})

	it("stops the actual bands at today and carries the projection to the cycle end", () => {
		const spendModel = unscaledModel(0)

		const series = buildCumulativeSeries({
			daily: daily([
				{ date: "2026-07-28", logsGB: 0 },
				{ date: "2026-07-29", logsGB: 0 },
				{ date: "2026-07-30", logsGB: 0 },
				{ date: "2026-07-31", logsGB: 0 },
			]),
			model: spendModel,
		})

		expect(series.map((point) => point.future)).toEqual([false, false, true, true])
		// Future days carry no bands: a flat line to the end of the cycle would
		// read as "spend stops here" rather than "these days haven't happened".
		expect(series.map((point) => point.base)).toEqual([39, 39, null, null])
		expect(series.map((point) => point.total)).toEqual([39, 39, null, null])

		// Exactly two projection anchors — today's actual total and the projected
		// total on the last day — so the dashed segment is a straight line.
		expect(series.map((point) => point.projected)).toEqual([
			null,
			39,
			null,
			spendModel.projectedCents / 100,
		])
	})

	it("has no projection anchor when the series already ends today", () => {
		const spendModel = unscaledModel(0)

		const series = buildCumulativeSeries({
			daily: daily([
				{ date: "2026-07-28", logsGB: 0 },
				{ date: "2026-07-29", logsGB: 0 },
			]),
			model: spendModel,
		})

		expect(series.map((point) => point.projected)).toEqual([null, 39])
	})

	it("scales the warehouse shape onto the metered total, so the chart matches the KPI", () => {
		const spendModel = model()
		if (spendModel === null) throw new Error("expected a model")

		// The metered total for logs is 390 GB; the warehouse series here sums to
		// 39 GB (a 10x metering gap). The last point must still price 390 GB of
		// logs — 290 GB over the 100 GB allotment at $0.30 = $87 — or the chart
		// would contradict the "spend so far" card directly above it.
		const series = buildCumulativeSeries({
			daily: daily([
				{ date: "2026-07-01", logsGB: 13 },
				{ date: "2026-07-02", logsGB: 13 },
				{ date: "2026-07-03", logsGB: 13 },
			]),
			model: spendModel,
		})

		expect(series[2]?.logs).toBeCloseTo(87, 6)
		// The daily shape survives the scaling — thirds of the cycle's overage.
		expect(series[0]?.logs).toBeCloseTo(9, 6)
	})

	it("returns an empty series when the warehouse read is unavailable", () => {
		const spendModel = model()
		if (spendModel === null) throw new Error("expected a model")
		expect(buildCumulativeSeries({ daily: undefined, model: spendModel })).toEqual([])
	})
})
