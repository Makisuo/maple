import { describe, it } from "@effect/vitest"
import { strictEqual } from "node:assert"
import { describeThrown } from "../src/server/serve"

// Production carried 94 spans reading exactly `Error: {}` at `POST /v1/traces`:
// one issue, no message, no type, no stack past the span name. Every case below
// used to land in that bucket, so the invariant this file pins is narrow and
// absolute — describeThrown NEVER returns something a human cannot act on.
describe("describeThrown", () => {
	it("prefers a real Error message", () => {
		strictEqual(describeThrown(new Error("chDB refused the insert")), "chDB refused the insert")
	})

	it("reads a message off a non-Error carrying one", () => {
		strictEqual(describeThrown({ message: "socket hang up" }), "socket hang up")
	})

	it("serializes a plain object that has no message", () => {
		strictEqual(describeThrown({ code: "ECONNRESET", errno: -54 }), '{"code":"ECONNRESET","errno":-54}')
	})

	it("names the shape when an object serializes to nothing", () => {
		// The exact `{}` case: a class instance whose state is non-enumerable.
		strictEqual(describeThrown(new Response("body")), "non-serializable Response thrown")
	})

	it("survives a circular object and a throwing getter", () => {
		const circular: Record<string, unknown> = {}
		circular.self = circular
		strictEqual(describeThrown(circular), "non-serializable Object thrown")

		const hostile = {
			get message(): string {
				throw new Error("nope")
			},
		}
		strictEqual(describeThrown(hostile), "non-serializable Object thrown")
	})

	it("describes primitives rather than dropping them", () => {
		strictEqual(describeThrown(undefined), "undefined thrown: undefined")
		strictEqual(describeThrown(null), "object thrown: null")
		strictEqual(describeThrown(42), "number thrown: 42")
	})

	it("never returns an empty, {} or [object Object] message", () => {
		const thrown: ReadonlyArray<unknown> = [
			new Error(""),
			{},
			{ message: "" },
			new Response("body"),
			undefined,
			null,
			"",
			0,
			[],
		]
		for (const value of thrown) {
			const described = describeThrown(value)
			strictEqual(described.length > 0, true, `empty description for ${String(value)}`)
			strictEqual(described === "{}", false, `bare {} for ${String(value)}`)
			strictEqual(described === "[object Object]", false, `bare [object Object] for ${String(value)}`)
		}
	})
})
