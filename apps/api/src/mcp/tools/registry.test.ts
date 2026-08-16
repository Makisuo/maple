import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { mapleToolCatalog, toInputSchema } from "./registry"

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
		const schema = toInputSchema(
			Schema.Struct({ a: Schema.Union([Schema.String, Schema.Number]) }),
		)
		const properties = schema.properties as Record<string, Record<string, unknown>>
		expect(Array.isArray(properties.a?.anyOf)).toBe(true)
		expect((properties.a?.anyOf as unknown[]).length).toBe(2)
	})

	it("still marks optional parameters as not required", () => {
		const schema = toInputSchema(
			Schema.Struct({ a: Schema.optional(Schema.String), b: Schema.String }),
		)
		expect(schema.required).toEqual(["b"])
	})
})
