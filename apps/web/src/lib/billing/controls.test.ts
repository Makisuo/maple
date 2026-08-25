import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import type { BillingCustomer } from "@maple/domain/http"
import { UpdateBillingControlsRequest } from "@maple/domain/http"

import { maximumInvoiceCents, updateFeatureControls } from "./controls"
import type { SpendModel } from "./spend"

const customer = {
	id: "org_test",
	subscriptions: [],
	billingControls: {
		spendLimits: [
			{
				featureId: "traces",
				enabled: true,
				limitType: "absolute",
				overageLimit: 75,
			},
		],
		usageAlerts: [
			{
				featureId: "metrics",
				enabled: true,
				threshold: 85,
				thresholdType: "usage_percentage",
			},
		],
	},
} as BillingCustomer

describe("updateFeatureControls", () => {
	// The endpoint payload is a Schema.Class, so the HttpApi client encoder checks
	// class identity: a plain literal dies with "Expected UpdateBillingControlsRequest"
	// before any request goes out, and tsc can't see it.
	it("returns a payload the endpoint encoder accepts", () => {
		const next = updateFeatureControls({
			customer,
			featureId: "logs",
			overageLimit: 250,
			alertPercent: 80,
		})

		expect(() => Schema.encodeUnknownSync(UpdateBillingControlsRequest)(next)).not.toThrow()
	})

	it("upserts only the selected feature so unrelated Autumn controls stay untouched", () => {
		const next = updateFeatureControls({
			customer,
			featureId: "logs",
			overageLimit: 250,
			alertPercent: 80,
		})

		expect(next.spendLimits).toEqual([
			{
				featureId: "logs",
				enabled: true,
				limitType: "absolute",
				overageLimit: 250,
			},
		])
		expect(next.usageAlerts).toEqual([
			{
				featureId: "logs",
				enabled: true,
				threshold: 80,
				thresholdType: "usage_percentage",
				name: "Maple billing warning",
			},
		])
		expect(next.spendLimits[0]).not.toHaveProperty("skipOverageBilling")
	})

	it("explicitly disables controls when their fields are cleared", () => {
		const next = updateFeatureControls({
			customer,
			featureId: "logs",
			overageLimit: null,
			alertPercent: null,
		})

		expect(next.spendLimits).toEqual([{ featureId: "logs", enabled: false }])
		expect(next.usageAlerts).toEqual([
			{
				featureId: "logs",
				enabled: false,
				threshold: 80,
				thresholdType: "usage_percentage",
				name: "Maple billing warning",
			},
		])
	})
})

describe("maximumInvoiceCents", () => {
	// SAFETY: maximumInvoiceCents reads only the base and per-feature cap fields supplied by this focused fixture.
	const model = {
		baseCents: 3_900,
		partial: false,
		features: [
			{ featureId: "logs", ratePerUnit: 0.3, unlimited: false, overageAllowed: true },
			{ featureId: "traces", ratePerUnit: 0.3, unlimited: false, overageAllowed: true },
			{ featureId: "metrics", ratePerUnit: 0.3, unlimited: true, overageAllowed: true },
			{ featureId: "browser_sessions", ratePerUnit: 0.002, unlimited: false, overageAllowed: false },
		],
	} as unknown as SpendModel

	it("adds every billable feature cap to the base invoice", () => {
		expect(
			maximumInvoiceCents(model, {
				...customer,
				billingControls: {
					spendLimits: [
						{ featureId: "logs", enabled: true, limitType: "absolute", overageLimit: 100 },
						{ featureId: "traces", enabled: true, limitType: "absolute", overageLimit: 50 },
					],
				},
			} as BillingCustomer),
		).toBe(8_400)
	})

	it("is unbounded when any billable feature is uncapped", () => {
		expect(maximumInvoiceCents(model, customer)).toBeNull()
	})
})
