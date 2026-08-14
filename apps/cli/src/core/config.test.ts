import { describe, expect, it } from "vitest"
import { parseLocalHeaders } from "./config"

describe("parseLocalHeaders", () => {
	it("parses comma-separated headers, trimming entries and splitting values on the first equals", () => {
		expect(parseLocalHeaders(" X-Test=1,Authorization=Bearer=a=b, Empty= , ,NoEquals")).toEqual({
			"X-Test": "1",
			Authorization: "Bearer=a=b",
			Empty: "",
		})
	})

	it("returns no headers when the environment variable is absent", () => {
		expect(parseLocalHeaders(undefined)).toEqual({})
	})
})
