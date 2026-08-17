import { assert, describe, it } from "@effect/vitest"
import {
	isSubscriptionName,
	isValidScopeValue,
	lookupSubscription,
	SUBSCRIPTION_NAMES,
	subscriptionScopeColumn,
} from "./registry"

describe("isShapeName", () => {
	it("accepts whitelisted shapes and rejects everything else", () => {
		assert.isTrue(isSubscriptionName("dashboards"))
		assert.isTrue(isSubscriptionName("alert_rules"))
		assert.isTrue(isSubscriptionName("alert_destinations"))
		assert.isTrue(isSubscriptionName("api_keys"))
		// Pruned from both the whitelist and the publication (0022) once their
		// client collections were removed — they must not resolve as shapes.
		assert.isFalse(isSubscriptionName("error_issues"))
		assert.isFalse(isSubscriptionName("actors"))
		assert.isFalse(isSubscriptionName("open_error_incidents"))
		assert.isFalse(isSubscriptionName("scrape_target_checks"))
		assert.isFalse(isSubscriptionName("users"))
		assert.isFalse(isSubscriptionName("dashboards; drop table"))
		assert.isFalse(isSubscriptionName(null))
		// Must not be fooled by prototype keys.
		assert.isFalse(isSubscriptionName("toString"))
		assert.isFalse(isSubscriptionName("constructor"))
	})
})

describe("lookupShape", () => {
	it("resolves a definition with a table for every whitelisted subscription", () => {
		for (const subscription of SUBSCRIPTION_NAMES) {
			assert.isString(lookupSubscription(subscription).table, subscription)
		}
	})

	it("keeps the PK in every column projection (Electric requires it)", () => {
		for (const subscription of SUBSCRIPTION_NAMES) {
			const columns = lookupSubscription(subscription).columns
			if (columns === undefined) continue
			assert.include(columns, "id", subscription)
			// org_id is the tenant boundary and is filtered on, so it must survive
			// the projection too.
			assert.include(columns, "org_id", subscription)
		}
	})
})

describe("scoped shapes", () => {
	it("marks exactly the investigation shapes as scoped", () => {
		assert.strictEqual(subscriptionScopeColumn("investigation"), "id")
		assert.strictEqual(subscriptionScopeColumn("investigation_lens_runs"), "investigation_id")
		// Everything else is org-wide; a stray `scope` on one of these is ignored.
		assert.isNull(subscriptionScopeColumn("dashboards"))
		assert.isNull(subscriptionScopeColumn("alert_rules"))
	})

	it("rejects an absent or unbounded scope value", () => {
		assert.isFalse(isValidScopeValue(null))
		assert.isFalse(isValidScopeValue(""))
		assert.isFalse(isValidScopeValue("x".repeat(129)))
		assert.isTrue(isValidScopeValue("inv_YofPTrK9782DWwcnXhpcCw"))
	})
})
