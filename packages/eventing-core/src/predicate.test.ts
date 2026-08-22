import { readFileSync } from "node:fs"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
	assertSignalProjectionInputBudget,
	compileSignalPredicate,
	defineSignalFields,
	fieldKey,
	makeEventId,
	MAX_PREDICATE_DEPTH,
	SignalLiteralSchema,
	SignalPredicateSchema,
	SignalScalarSchema,
	timestampToEpochNanos,
	validateSignalPredicate,
	type EventIdentityInput,
	type FieldNamespace,
	type FieldRef,
	type NormalizedSignal,
	type SignalPredicate,
} from "./index"

interface ConformanceFixture {
	readonly eventIdVectors: ReadonlyArray<{
		readonly name: string
		readonly input: EventIdentityInput
		readonly output: string
	}>
	readonly stringLiteralByteVectors: ReadonlyArray<{
		readonly name: string
		readonly unit: string
		readonly repeat: number
		readonly valid: boolean
	}>
	readonly predicateVectors: ReadonlyArray<{
		readonly name: string
		readonly predicate: unknown
		readonly fields: ReadonlyArray<{
			readonly namespace: FieldNamespace
			readonly key: string
			readonly value: unknown
		}>
		readonly matches: boolean
		readonly typeMismatches?: readonly string[]
	}>
}

// SAFETY: the conformance suite exercises every decoded fixture field below against its owning schema.
const fixture = JSON.parse(
	readFileSync(new URL("../fixtures/v1.json", import.meta.url), "utf8"),
) as ConformanceFixture

const signalFor = (fields: ConformanceFixture["predicateVectors"][number]["fields"]): NormalizedSignal => ({
	sourceKind: "otel.log",
	source: "urn:maple:source:otel:local",
	tenantId: "tenant-a",
	occurrenceId: "occurrence-1",
	identityQuality: "source",
	occurredAt: "2026-08-07T19:42:00Z",
	observedAt: "2026-08-07T19:42:01Z",
	subject: null,
	fields: defineSignalFields(
		fields.map(({ namespace, key, value }) => ({
			field: {
				namespace,
				key,
				type: Schema.decodeUnknownSync(SignalScalarSchema)(value).type,
			},
			value: Schema.decodeUnknownSync(SignalScalarSchema)(value),
		})),
	),
	data: {},
})

describe("cross-language conformance vectors", () => {
	for (const vector of fixture.eventIdVectors) {
		it(`event ID: ${vector.name}`, () => {
			expect(makeEventId(vector.input)).toBe(vector.output)
		})
	}

	for (const vector of fixture.stringLiteralByteVectors) {
		it(`string literal bytes: ${vector.name}`, () => {
			const candidate = { type: "string", value: vector.unit.repeat(vector.repeat) }
			if (vector.valid)
				expect(() => Schema.decodeUnknownSync(SignalLiteralSchema)(candidate)).not.toThrow()
			else expect(() => Schema.decodeUnknownSync(SignalLiteralSchema)(candidate)).toThrow()
		})
	}

	for (const vector of fixture.predicateVectors) {
		it(`predicate: ${vector.name}`, () => {
			const predicate = Schema.decodeUnknownSync(SignalPredicateSchema)(vector.predicate)
			const result = compileSignalPredicate(predicate)(signalFor(vector.fields))
			expect(result.matches).toBe(vector.matches)
			expect(result.typeMismatches.map(fieldKey)).toEqual(vector.typeMismatches ?? [])
		})
	}
})

describe("selector validation", () => {
	it("rejects wrong literal types and unsupported ordering", () => {
		const field: FieldRef = { namespace: "attribute", key: "enabled", type: "boolean" }
		expect(
			validateSignalPredicate({ op: "gt", field, value: { type: "string", value: "true" } }),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ message: "gt is not supported for boolean" }),
				expect.objectContaining({ message: "field and literal types must match" }),
			]),
		)
	})

	it("rejects empty combinators and excessive nesting", () => {
		expect(validateSignalPredicate({ op: "all", clauses: [] })).toContainEqual({
			path: "selector.clauses",
			message: "all requires at least one clause",
		})

		let nested = {
			op: "exists" as const,
			field: { namespace: "attribute" as const, key: "x", type: "string" as const },
		}
		for (let i = 0; i < MAX_PREDICATE_DEPTH; i++) nested = { op: "not", clause: nested } as never
		expect(validateSignalPredicate(nested)).toEqual(
			expect.arrayContaining([expect.objectContaining({ message: `predicate depth exceeds 8` })]),
		)
	})

	it("rejects invalid calendar dates and int64 overflow", () => {
		expect(timestampToEpochNanos("2026-02-31T00:00:00Z")).toBeNull()
		expect(
			validateSignalPredicate({
				op: "eq",
				field: { namespace: "attribute", key: "n", type: "int64" },
				value: { type: "int64", value: "9223372036854775808" },
			}),
		).toContainEqual(
			expect.objectContaining({ message: "int64 must be a signed 64-bit decimal integer" }),
		)
	})

	it("rejects hostile raw predicate topology before recursive schema decoding", () => {
		let deeplyNested: SignalPredicate = {
			op: "exists",
			field: { namespace: "attribute", key: "x", type: "string" },
		}
		for (let index = 0; index < MAX_PREDICATE_DEPTH; index++)
			deeplyNested = { op: "not", clause: deeplyNested }
		expect(() => assertSignalProjectionInputBudget({ selector: deeplyNested })).toThrow(
			"predicate depth exceeds",
		)

		expect(() =>
			assertSignalProjectionInputBudget({
				selector: {
					op: "all",
					clauses: Array.from({ length: 65 }, () => ({
						op: "exists",
						field: { namespace: "attribute", key: "x", type: "string" },
					})),
				},
			}),
		).toThrow("clause list exceeds")

		expect(() =>
			assertSignalProjectionInputBudget({
				selector: {
					op: "eq",
					field: { namespace: "attribute", key: "n", type: "int64" },
					value: { type: "int64", value: "1".repeat(21) },
				},
			}),
		).toThrow("int64 literal exceeds")
	})
})

describe("total runtime behavior", () => {
	it("accepts valid large source strings for exists and small contains literals", () => {
		const largeValue = `${"a".repeat(5 * 1024)}needle`
		const signal = signalFor([
			{
				namespace: "attribute",
				key: "large.description",
				value: { type: "string", value: largeValue },
			},
		])
		const field = {
			namespace: "attribute" as const,
			key: "large.description",
			type: "string" as const,
		}

		expect(compileSignalPredicate({ op: "exists", field })(signal).matches).toBe(true)
		expect(
			compileSignalPredicate({
				op: "contains",
				field,
				value: { type: "string", value: "needle" },
			})(signal).matches,
		).toBe(true)
	})

	it("treats malformed source scalars as mismatches rather than throwing", () => {
		const field: FieldRef = { namespace: "attribute", key: "n", type: "int64" }
		const evaluate = compileSignalPredicate({
			op: "gte",
			field,
			value: { type: "int64", value: "1" },
		})
		const signal = signalFor([])
		const fields = new Map(signal.fields)
		fields.set(fieldKey(field), { type: "int64", value: "not-an-integer" })
		expect(evaluate({ ...signal, fields })).toMatchObject({
			matches: false,
			typeMismatches: [field],
		})
	})

	it("distinguishes neq from not(eq) for a missing field", () => {
		const field: FieldRef = { namespace: "attribute", key: "state", type: "string" }
		const eq = { op: "eq" as const, field, value: { type: "string" as const, value: "closed" } }
		expect(compileSignalPredicate({ ...eq, op: "neq" })(signalFor([])).matches).toBe(false)
		expect(compileSignalPredicate({ op: "not", clause: eq })(signalFor([])).matches).toBe(true)
	})
})
