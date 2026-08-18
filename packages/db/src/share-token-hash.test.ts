import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { AlertRuleId, OrgId } from "@maple/domain/primitives"
import {
	alertChartId,
	generateShareToken,
	hashShareToken,
	shareOgId,
	shareTokenSuffix,
	verifyAlertChartId,
	verifyShareOgId,
} from "./share-token-hash"

const KEY = "test-share-hmac-key"
const SHARE_ID = "dshare_0f2b6a8e-6c1b-4f2a-9f6e-1d2c3b4a5e6f"

describe("hashShareToken", () => {
	it("is deterministic and keyed", () => {
		const token = generateShareToken()

		expect(hashShareToken(token, KEY)).toBe(hashShareToken(token, KEY))
		expect(hashShareToken(token, "other-key")).not.toBe(hashShareToken(token, KEY))
	})
})

describe("shareTokenSuffix", () => {
	it("keeps the last six characters", () => {
		expect(shareTokenSuffix("mshare_abcdefghij")).toBe("efghij")
	})
})

describe("shareOgId", () => {
	it("round-trips the share id", () => {
		expect(verifyShareOgId(shareOgId(SHARE_ID, KEY), KEY)).toBe(SHARE_ID)
	})

	it("never contains the share token", () => {
		const token = generateShareToken()

		expect(shareOgId(SHARE_ID, KEY)).not.toContain(token)
		expect(shareOgId(SHARE_ID, KEY)).not.toContain(hashShareToken(token, KEY))
	})

	it("rejects a tampered id, a tampered signature, and a foreign key", () => {
		const ogId = shareOgId(SHARE_ID, KEY)
		const [encodedId, signature] = ogId.split(".") as [string, string]
		const otherId = Buffer.from("dshare_someone-elses-share", "utf8").toString("base64url")

		expect(verifyShareOgId(`${otherId}.${signature}`, KEY)).toBeUndefined()
		expect(verifyShareOgId(`${encodedId}.${signature.slice(0, -1)}x`, KEY)).toBeUndefined()
		expect(verifyShareOgId(ogId, "another-key")).toBeUndefined()
	})

	it("rejects malformed input rather than throwing", () => {
		expect(verifyShareOgId("", KEY)).toBeUndefined()
		expect(verifyShareOgId("no-separator", KEY)).toBeUndefined()
		expect(verifyShareOgId(".signature-only", KEY)).toBeUndefined()
		// A short signature must not reach `timingSafeEqual`, which throws on a
		// length mismatch.
		expect(verifyShareOgId(`${Buffer.from(SHARE_ID).toString("base64url")}.short`, KEY)).toBeUndefined()
	})
})

// Decoded, not cast: `AlertRuleId` is a UUID brand, so a placeholder like
// "rule_1" is not merely untyped here — it is not a valid id at all.
const ORG_ID = Schema.decodeUnknownSync(OrgId)("org_3Aui9f2b6a8e")
const RULE_ID = Schema.decodeUnknownSync(AlertRuleId)("1f2b6a8e-6c1b-4f2a-9f6e-1d2c3b4a5e6f")

const claims = {
	orgId: ORG_ID,
	ruleId: RULE_ID,
	groupKey: "checkout-api",
	fromMs: Date.UTC(2026, 7, 18, 13, 0),
	toMs: Date.UTC(2026, 7, 18, 14, 0),
	title: "Error Rate · checkout-api",
	unit: "percent",
	threshold: 2,
	breachSide: "above",
} as const

/** What `claims` looks like coming back out — ids undecoded, by design. */
const verified = {
	rawOrgId: ORG_ID as string,
	rawRuleId: RULE_ID as string,
	groupKey: claims.groupKey,
	fromMs: claims.fromMs,
	toMs: claims.toMs,
	title: claims.title,
	unit: claims.unit,
	threshold: claims.threshold,
	breachSide: claims.breachSide,
}

/**
 * Re-signs nothing: it swaps one claim inside an id and keeps the original
 * signature, which is exactly the forgery `verifyAlertChartId` must refuse.
 *
 */
const tamperAlertChartClaim = (id: string, index: number, value: unknown): string => {
	// SAFETY: `alertChartId` always emits exactly `<payload>.<signature>`.
	const [encoded, signature] = id.split(".") as [string, string]
	// SAFETY: the payload is the array `encodeAlertChartClaims` just wrote.
	const claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown[]
	claims[index] = value
	return `${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}.${signature}`
}

describe("alertChartId", () => {
	it("round-trips the claims, with the ids left undecoded", () => {
		// The signature proves we minted it; it does not decode an entity id, so
		// they come back as `raw*` for the caller to parse at its boundary.
		expect(verifyAlertChartId(alertChartId(claims, KEY), KEY)).toEqual(verified)
	})

	it("round-trips an ungrouped rule's null group", () => {
		const ungrouped = { ...claims, groupKey: null }
		expect(verifyAlertChartId(alertChartId(ungrouped, KEY), KEY)).toEqual({
			...verified,
			groupKey: null,
		})
	})

	it("is deterministic, so a redelivery renders the same image", () => {
		expect(alertChartId(claims, KEY)).toBe(alertChartId(claims, KEY))
	})

	it("rejects an id minted under a different key", () => {
		expect(verifyAlertChartId(alertChartId(claims, "other-key"), KEY)).toBeUndefined()
	})

	it("rejects a widened window, which is what stops an arbitrary-range scan", () => {
		// The window is signed precisely so a holder of the URL cannot turn a
		// one-hour chart into a one-year warehouse scan.
		const forged = tamperAlertChartClaim(alertChartId(claims, KEY), 3, 0)
		expect(verifyAlertChartId(forged, KEY)).toBeUndefined()
	})

	it("rejects a lowered threshold, so an image cannot be made to look worse", () => {
		// The threshold is signed, so a delivered alert's picture cannot be
		// re-pointed at a different line after the fact.
		const forged = tamperAlertChartClaim(alertChartId(claims, KEY), 7, 0.1)
		expect(verifyAlertChartId(forged, KEY)).toBeUndefined()
	})

	it("rejects a rewritten title, which is what stops the URL drawing arbitrary words", () => {
		const forged = tamperAlertChartClaim(alertChartId(claims, KEY), 5, "Everything is fine")
		expect(verifyAlertChartId(forged, KEY)).toBeUndefined()
	})

	it("rejects a swapped rule id", () => {
		const id = alertChartId(claims, KEY)
		const other = alertChartId(
			{
				...claims,
				ruleId: Schema.decodeUnknownSync(AlertRuleId)("2f2b6a8e-6c1b-4f2a-9f6e-1d2c3b4a5e6f"),
			},
			KEY,
		)
		const forged = `${id.split(".")[0]}.${other.split(".")[1]}`
		expect(verifyAlertChartId(forged, KEY)).toBeUndefined()
	})

	it("rejects malformed ids without throwing", () => {
		for (const bad of ["", ".", "nodot", ".onlysig", "a.b", "!!!.???"]) {
			expect(verifyAlertChartId(bad, KEY)).toBeUndefined()
		}
	})

	it("does not accept a share OG id, and vice versa", () => {
		// Distinct domain-separation labels: a signature minted to render a
		// dashboard preview must not render an alert chart.
		expect(verifyAlertChartId(shareOgId("share_1", KEY), KEY)).toBeUndefined()
		expect(verifyShareOgId(alertChartId(claims, KEY), KEY)).toBeUndefined()
	})
})
