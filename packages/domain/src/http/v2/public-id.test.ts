import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { ApiKeyId, DashboardId } from "../../primitives"
import { decodePublicId, encodePublicId, PublicId, PublicIdPrefixes } from "./public-id"

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e"

describe("encodePublicId / decodePublicId", () => {
	it("round-trips a UUID internal ID", () => {
		const publicId = encodePublicId("key", UUID)
		expect(publicId.startsWith("key_")).toBe(true)
		expect(decodePublicId("key", publicId)).toBe(UUID)
	})

	it("round-trips a free-form string internal ID", () => {
		const internal = "my-dashboard-2024"
		const publicId = encodePublicId("dash", internal)
		expect(publicId.startsWith("dash_")).toBe(true)
		expect(decodePublicId("dash", publicId)).toBe(internal)
	})

	it("round-trips unicode free-form IDs", () => {
		const internal = "ダッシュ boards/π"
		expect(decodePublicId("dash", encodePublicId("dash", internal))).toBe(internal)
	})

	it("is deterministic", () => {
		expect(encodePublicId("key", UUID)).toBe(encodePublicId("key", UUID))
	})

	it("normalizes UUID case on round-trip", () => {
		expect(decodePublicId("key", encodePublicId("key", UUID.toUpperCase()))).toBe(UUID)
	})

	it("rejects a wrong prefix", () => {
		const publicId = encodePublicId("key", UUID)
		expect(decodePublicId("dash", publicId)).toBeNull()
	})

	it("rejects garbage bodies", () => {
		expect(decodePublicId("key", "key_")).toBeNull()
		expect(decodePublicId("key", "key_0OIl")).toBeNull() // chars outside base58 alphabet
		expect(decodePublicId("key", "key_zzzz")).toBeNull() // undecodable payload
		expect(decodePublicId("key", "not-a-public-id")).toBeNull()
	})
})

describe("PublicId schema codec", () => {
	const KeyId = PublicId(PublicIdPrefixes.apiKey, ApiKeyId)
	const decode = Schema.decodeUnknownSync(KeyId)
	const encode = Schema.encodeSync(KeyId)

	it("decodes a wire public ID to the internal branded ID", () => {
		const wire = encodePublicId("key", UUID)
		expect(decode(wire)).toBe(UUID)
	})

	it("encodes an internal ID to the wire public ID", () => {
		const internal = Schema.decodeUnknownSync(ApiKeyId)(UUID)
		expect(encode(internal)).toBe(encodePublicId("key", UUID))
	})

	it("fails decode on a malformed wire ID", () => {
		expect(() => decode("key_not!base58")).toThrow()
		expect(() => decode("dash_abc")).toThrow()
	})

	it("supports free-form internal ID schemas", () => {
		const DashId = PublicId(PublicIdPrefixes.dashboard, DashboardId)
		const internal = Schema.decodeUnknownSync(DashboardId)("service-overview")
		const wire = Schema.encodeSync(DashId)(internal)
		expect(wire.startsWith("dash_")).toBe(true)
		expect(Schema.decodeUnknownSync(DashId)(wire)).toBe("service-overview")
	})
})
