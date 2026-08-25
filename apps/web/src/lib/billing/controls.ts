import type { BillingCustomer, BillingSpendLimit, BillingUsageAlert } from "@maple/domain/http"
import {
	UpdateBillingControlsRequest,
	UpdateBillingSpendLimit as UpdateBillingSpendLimitClass,
	UpdateBillingUsageAlert as UpdateBillingUsageAlertClass,
} from "@maple/domain/http"

import type { SpendFeatureId, SpendModel } from "./spend"

const MAPLE_USAGE_ALERT_NAME = "Maple billing warning"

export const spendLimitFor = (
	customer: BillingCustomer | undefined,
	featureId: SpendFeatureId,
): BillingSpendLimit | undefined =>
	customer?.billingControls?.spendLimits?.find((limit) => limit.featureId === featureId && limit.enabled)

export const usageAlertFor = (
	customer: BillingCustomer | undefined,
	featureId: SpendFeatureId,
): BillingUsageAlert | undefined =>
	customer?.billingControls?.usageAlerts?.find(
		(alert) => alert.featureId === featureId && alert.enabled && alert.name === MAPLE_USAGE_ALERT_NAME,
	)

/**
 * Upsert one feature's Maple-managed controls. Disabled entries are deliberate:
 * Autumn removes a control only when that feature is explicitly disabled.
 */
export const updateFeatureControls = ({
	customer,
	featureId,
	overageLimit,
	alertPercent,
}: {
	readonly customer: BillingCustomer
	readonly featureId: SpendFeatureId
	readonly overageLimit: number | null
	readonly alertPercent: number | null
}): UpdateBillingControlsRequest => {
	const currentAlert = usageAlertFor(customer, featureId)
	return new UpdateBillingControlsRequest({
		spendLimits: [
			new UpdateBillingSpendLimitClass({
				featureId,
				enabled: overageLimit !== null,
				...(!(overageLimit === null) ? { limitType: "absolute" as const, overageLimit } : undefined),
			}),
		],
		usageAlerts: [
			new UpdateBillingUsageAlertClass({
				featureId,
				enabled: alertPercent !== null,
				threshold: alertPercent ?? currentAlert?.threshold ?? 80,
				thresholdType: "usage_percentage",
				name: MAPLE_USAGE_ALERT_NAME,
			}),
		],
	})
}

/** Maximum invoice when every paid feature has a cap; null means unbounded. */
export const maximumInvoiceCents = (
	model: SpendModel | null,
	customer: BillingCustomer | undefined,
): number | null => {
	if (model === null || model.partial) return null
	let maximum = model.baseCents
	for (const feature of model.features) {
		if (feature.unlimited || feature.ratePerUnit === null || feature.overageAllowed === false) continue
		const limit = spendLimitFor(customer, feature.featureId)?.overageLimit
		if (limit === undefined) return null
		maximum += Math.round(limit * feature.ratePerUnit * 100)
	}
	return maximum
}
