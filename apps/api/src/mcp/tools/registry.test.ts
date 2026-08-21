import { describe, expect, it } from "vitest"
import { Effect, Exit, Schema } from "effect"
import { mapleToolCatalog, toInputSchema } from "./registry"
import { optionalNumberParam } from "./types"

const jsonOf = (schema: unknown): string => JSON.stringify(schema)

describe("toInputSchema nullable-union collapse", () => {
	// The invariant `collapseNullableUnions` depends on. `Schema.optional(X)` types
	// as `X | undefined` and REJECTS an explicit null, but renders a JSON `null`
	// branch — so collapsing it makes the published schema match the decoder. A
	// `Schema.NullOr` parameter would render identically while genuinely accepting
	// null, and would be wrongly narrowed. If this ever fails, make the collapse
	// selective before trusting it again.
	it("no REQUIRED tool parameter carries a null branch", () => {
		// An optional parameter's null branch is the artifact being removed: absence
		// and null mean the same thing there, so collapsing is safe. A REQUIRED one
		// would be a real `Schema.NullOr` — null is a value it accepts — and
		// collapsing that would narrow the contract. None exist today; this fails if
		// one is ever added.
		const nullableRequired: string[] = []
		for (const definition of mapleToolCatalog) {
			const document = Schema.toJsonSchemaDocument(definition.schema)
			const schema = document.schema as {
				required?: ReadonlyArray<string>
				properties?: Record<string, { anyOf?: ReadonlyArray<{ type?: string }> }>
			}
			for (const name of schema.required ?? []) {
				const branches = schema.properties?.[name]?.anyOf ?? []
				if (branches.some((branch) => branch.type === "null")) {
					nullableRequired.push(`${definition.name}.${name}`)
				}
			}
		}
		expect(nullableRequired).toEqual([])
	})

	it("publishes no null branch on any tool", () => {
		const withNull = mapleToolCatalog
			.filter((d) => jsonOf(toInputSchema(d.schema)).includes('"type":"null"'))
			.map((d) => d.name)
		expect(withNull).toEqual([])
	})

	it("keeps the parameter description when it collapses the union", () => {
		const schema = toInputSchema(
			Schema.Struct({
				a: Schema.optional(Schema.String).annotate({ description: "the a param" }),
			}),
		)
		const properties = schema.properties as Record<string, Record<string, unknown>>
		expect(properties.a?.type).toBe("string")
		expect(properties.a?.description).toBe("the a param")
		expect(properties.a?.anyOf).toBeUndefined()
	})

	it("leaves a non-nullable union alone", () => {
		const schema = toInputSchema(Schema.Struct({ a: Schema.Union([Schema.String, Schema.Number]) }))
		const properties = schema.properties as Record<string, Record<string, unknown>>
		expect(Array.isArray(properties.a?.anyOf)).toBe(true)
		expect((properties.a?.anyOf as unknown[]).length).toBe(2)
	})

	it("still marks optional parameters as not required", () => {
		const schema = toInputSchema(Schema.Struct({ a: Schema.optional(Schema.String), b: Schema.String }))
		expect(schema.required).toEqual(["b"])
	})
})

describe("optionalNumberParam", () => {
	const schema = Schema.Struct({ p: optionalNumberParam("a duration in ms") })
	const decode = (p: unknown) => Effect.runSyncExit(Schema.decodeUnknownEffect(schema)({ p }))
	const accepts = (p: unknown) => {
		const exit = decode(p)
		return Exit.isSuccess(exit) ? (exit.value as { p?: number }).p : "REJECTED"
	}

	// `Schema.Number` published `anyOf: [number, {string, enum: [Infinity, -Infinity, NaN]}]`
	// on all ~30 numeric parameters, because JSON cannot carry a non-finite number.
	// A model reading a "number or string" type reasonably sent "1500" — which the
	// decoder then rejected. `Schema.Finite` has no non-finite branch to encode.
	it("publishes a clean number/string union with no non-finite enum branch", () => {
		const properties = toInputSchema(schema).properties as Record<string, Record<string, unknown>>
		expect(properties.p?.anyOf).toEqual([{ type: "number" }, { type: "string" }])
		expect(properties.p?.description).toBe("a duration in ms")
	})

	it("publishes no non-finite enum branch on any tool in the catalog", () => {
		const withEnum = mapleToolCatalog
			.filter((d) => jsonOf(toInputSchema(d.schema)).includes('"-Infinity"'))
			.map((d) => d.name)
		expect(withEnum).toEqual([])
	})

	it("accepts numbers and numeric strings alike", () => {
		expect(accepts(1500)).toBe(1500)
		expect(accepts(0)).toBe(0)
		expect(accepts(-3)).toBe(-3)
		expect(accepts(1.5)).toBe(1.5)
		expect(accepts("1500")).toBe(1500)
		expect(accepts("1.5e3")).toBe(1500)
		expect(accepts(" 42 ")).toBe(42)
	})

	// `NumberFromString` is `Number(s)` and does not validate. Each of these would
	// otherwise decode to a value and ride into the warehouse query: "soon" as NaN,
	// "" and "   " as 0 — an empty result set instead of an error.
	it("rejects every string that is not a finite number", () => {
		for (const value of ["soon", "1500ms", "", "   ", "Infinity", "NaN"]) {
			expect(accepts(value)).toBe("REJECTED")
		}
	})

	it("rejects non-finite numbers and non-numeric types", () => {
		for (const value of [Number.POSITIVE_INFINITY, Number.NaN, null, true, {}]) {
			expect(accepts(value)).toBe("REJECTED")
		}
	})

	// These strings are read by a model mid-tool-call and are its only chance to
	// self-correct, so a rejection has to name the fix. The blank case originally
	// rendered as the useless `Expected <filter>`.
	it("explains how to correct a rejected value", () => {
		const message = (p: unknown) => {
			const exit = decode(p)
			return Exit.isFailure(exit) ? String(exit.cause) : "ACCEPTED"
		}
		expect(message("")).toContain("omit the parameter")
		expect(message("   ")).toContain("omit the parameter")
		expect(message("soon")).toContain("Expected a finite number")
		expect(message("")).not.toContain("<filter>")
	})

	// Absence still means absence — the leniency is about encoding, not presence.
	it("leaves an omitted parameter omitted", () => {
		expect(Effect.runSync(Schema.decodeUnknownEffect(schema)({}))).toEqual({})
	})
})
