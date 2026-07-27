import { toJsonSchema } from "@valibot/to-json-schema"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { jsonSchemaToValibot } from "./json-schema-to-valibot.ts"

/** What the model ends up seeing: Flue derives the tool's JSON Schema back out. */
const roundTrip = (schema: Record<string, unknown>) => {
	const { $schema: _ignored, ...json } = toJsonSchema(jsonSchemaToValibot(schema), {
		errorMode: "ignore",
	})
	return json
}

const parse = (schema: Record<string, unknown>, value: unknown) =>
	v.safeParse(jsonSchemaToValibot(schema), value)

describe("jsonSchemaToValibot", () => {
	it("keeps a tool's parameters visible to the model", () => {
		expect(
			roundTrip({
				type: "object",
				properties: {
					service: { type: "string", description: "Service name" },
					limit: { type: "integer" },
					verbose: { type: "boolean" },
				},
				required: ["service"],
			}),
		).toEqual({
			type: "object",
			properties: {
				service: { type: "string", description: "Service name" },
				limit: { type: "integer" },
				verbose: { type: "boolean" },
			},
			required: ["service"],
		})
	})

	it("accepts input that omits optional properties", () => {
		const schema = {
			type: "object",
			properties: { service: { type: "string" }, limit: { type: "number" } },
			required: ["service"],
		}
		expect(parse(schema, { service: "checkout" }).success).toBe(true)
		expect(parse(schema, {}).success).toBe(false)
	})

	it("converts enums, including boolean members picklist cannot hold", () => {
		expect(
			parse({ type: "object", properties: { m: { enum: ["p50", "p95"] } } }, { m: "p95" }).success,
		).toBe(true)
		expect(
			parse({ type: "object", properties: { m: { enum: ["p50", "p95"] } } }, { m: "p99" }).success,
		).toBe(false)
		expect(
			parse({ type: "object", properties: { on: { enum: [true, false] } } }, { on: true }).success,
		).toBe(true)
	})

	it("resolves $ref into $defs", () => {
		const schema = {
			type: "object",
			properties: { filter: { $ref: "#/$defs/Filter" } },
			$defs: {
				Filter: { type: "object", properties: { field: { type: "string" } }, required: ["field"] },
			},
		}
		expect(parse(schema, { filter: { field: "service" } }).success).toBe(true)
		expect(parse(schema, { filter: {} }).success).toBe(false)
	})

	it("handles arrays, unions and nullable types", () => {
		expect(
			parse(
				{ type: "object", properties: { ids: { type: "array", items: { type: "string" } } } },
				{
					ids: ["a", "b"],
				},
			).success,
		).toBe(true)
		expect(
			parse(
				{ type: "object", properties: { v: { anyOf: [{ type: "string" }, { type: "number" }] } } },
				{
					v: 3,
				},
			).success,
		).toBe(true)
		expect(
			parse({ type: "object", properties: { v: { type: ["string", "null"] } } }, { v: null }).success,
		).toBe(true)
	})

	it("degrades an unrecognised property to unknown rather than dropping the tool", () => {
		expect(
			parse({ type: "object", properties: { weird: {} } }, { weird: { any: "thing" } }).success,
		).toBe(true)
	})

	it("always produces a top-level object schema, which defineTool requires", () => {
		// A parameterless tool, and a document Effect could not express as an object.
		expect(jsonSchemaToValibot({}).type).toBe("object")
		expect(jsonSchemaToValibot({ type: "string" }).type).toBe("object")
	})
})
