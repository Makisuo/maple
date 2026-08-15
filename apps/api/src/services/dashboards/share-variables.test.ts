import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { preservesClauseStructure, resolveShareVariables } from "./share-variables"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect))

const custom = {
	name: "service",
	type: "custom" as const,
	options: [{ value: "frontend" }, { value: "api" }],
}
const textbox = { name: "search", type: "textbox" as const }

describe("resolveShareVariables", () => {
	it("accepts a value the board actually offers", async () => {
		const result = await run(resolveShareVariables([custom], { service: "api" }))
		expect(result._tag).toBe("Success")
		if (result._tag === "Success") {
			expect(result.success.service).toEqual({
				value: "api",
				isAll: false,
				options: ["frontend", "api"],
			})
		}
	})

	it("refuses a value outside the enumerated options", async () => {
		// The whole proposition of a scoped share is that the scope holds. A viewer
		// naming a service the board never offered is the simplest way to break it.
		const result = await run(resolveShareVariables([custom], { service: "billing-internal" }))
		expect(result._tag).toBe("Failure")
	})

	it("refuses $__all unless the board offers an All option", async () => {
		const withoutAll = await run(resolveShareVariables([custom], { service: "$__all" }))
		expect(withoutAll._tag).toBe("Failure")

		const withAll = await run(
			resolveShareVariables([{ ...custom, includeAll: true }], { service: "$__all" }),
		)
		expect(withAll._tag).toBe("Success")
	})

	it("accepts ordinary free text", async () => {
		for (const value of ["payments-api", "prod", "/v2/users", "api.example.com:8443", "500"]) {
			const result = await run(resolveShareVariables([textbox], { search: value }))
			expect(result._tag, value).toBe("Success")
		}
	})

	it("refuses free text that could rewrite the clause grammar", async () => {
		// Each of these is a way to turn one predicate into something else. The
		// charset stops them before the clause-count check ever runs.
		for (const value of [
			"x' OR 1=1 --",
			"frontend' AND service.name != 'x",
			"a AND b",
			'a" OR "1"="1',
			"a; DROP TABLE spans",
			"a\nOR b",
		]) {
			const result = await run(resolveShareVariables([textbox], { search: value }))
			expect(result._tag, value).toBe("Failure")
		}
	})

	it("applies the clause-count check as a second, independent layer", async () => {
		// A value the charset happily allows, against a template where it would
		// still change the predicate count. This is what keeps the boundary honest
		// if the charset is ever loosened — the charset is a guess about a grammar
		// this module does not own, the clause count is a direct assertion.
		const template = "service.name = $search"
		const result = await run(resolveShareVariables([textbox], { search: "a" }, {}, [template]))
		expect(result._tag).toBe("Success")

		// `preservesClauseStructure` is what that layer calls, verified directly
		// against a value the charset would let through if spaces were allowed.
		expect(preservesClauseStructure(template, "a")).toBe(true)
		expect(preservesClauseStructure(template, "a AND status = 500")).toBe(false)
	})

	it("caps free-text length", async () => {
		const result = await run(resolveShareVariables([textbox], { search: "a".repeat(129) }))
		expect(result._tag).toBe("Failure")
	})

	it("drops a variable the board does not declare", async () => {
		// A stale or hand-edited URL should render the dashboard, not 400.
		const result = await run(resolveShareVariables([custom], { removed: "whatever" }))
		expect(result._tag).toBe("Success")
		if (result._tag === "Success") expect(result.success.removed).toBeUndefined()
	})

	it("falls back to the stored default when nothing is submitted", async () => {
		const result = await run(resolveShareVariables([{ ...custom, defaultValue: "frontend" }], {}))
		expect(result._tag).toBe("Success")
		if (result._tag === "Success") expect(result.success.service?.value).toBe("frontend")
	})

	it("validates a query variable against its resolved option list", async () => {
		const definition = { name: "env", type: "query" as const }
		const ok = await run(resolveShareVariables([definition], { env: "prod" }, { env: ["prod", "stg"] }))
		expect(ok._tag).toBe("Success")

		const bad = await run(resolveShareVariables([definition], { env: "secret" }, { env: ["prod"] }))
		expect(bad._tag).toBe("Failure")
	})
})

describe("preservesClauseStructure", () => {
	it("holds for a value that stays one predicate", () => {
		expect(preservesClauseStructure("service.name = '$service'", "payments-api")).toBe(true)
	})

	it("catches a value that adds a predicate", () => {
		// The direct check on the property that matters, independent of whatever
		// the charset happens to allow.
		expect(preservesClauseStructure("service.name = $service", "a AND status = 500")).toBe(false)
	})
})
