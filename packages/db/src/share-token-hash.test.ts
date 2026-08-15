import { describe, expect, it } from "vitest"
import {
	generateShareToken,
	hashShareToken,
	shareOgId,
	shareTokenSuffix,
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
