import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { PgText, PgTextDefault, toPgText } from "./pg-text"

describe("PgText", () => {
	it("decode strips NUL bytes, which Postgres text refuses", () => {
		assert.strictEqual(
			toPgText("failed at position 1 (\u0000\u0000): \u0000x"),
			"failed at position 1 (): x",
		)
	})

	it("decode leaves ordinary text alone", () => {
		assert.strictEqual(toPgText("upstream timed out"), "upstream timed out")
	})

	it("decode caps length and says how much was dropped", () => {
		assert.strictEqual(Schema.decodeSync(PgText(4))("abcdefghij"), "abcd…[truncated 6 chars]")
	})

	it("decode measures the cap after stripping", () => {
		assert.strictEqual(Schema.decodeSync(PgText(4))("ab\u0000cd"), "abcd")
	})

	it("encode is the identity — stored text is already safe", () => {
		assert.strictEqual(Schema.encodeSync(PgTextDefault)("already clean"), "already clean")
	})

	it("composes into a row schema", () => {
		const Row = Schema.Struct({ message: PgTextDefault, frame: PgTextDefault })
		assert.deepStrictEqual(Schema.decodeUnknownSync(Row)({ message: "a\u0000b", frame: "c" }), {
			message: "ab",
			frame: "c",
		})
	})
})
