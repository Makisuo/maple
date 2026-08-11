import { Schema } from "effect"

export const MAX_PREDICATE_DEPTH = 8
export const MAX_PREDICATE_NODES = 64
export const MAX_IN_VALUES = 100
export const MAX_STRING_LITERAL_BYTES = 4 * 1024
export const MAX_DECIMAL_INT64_LENGTH = 20

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength

const NonEmptyIdentifier = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(256),
	Schema.isTrimmed(),
)

const DecimalInt64 = Schema.String.check(
	Schema.isMaxLength(MAX_DECIMAL_INT64_LENGTH),
	Schema.isPattern(/^-?(?:0|[1-9][0-9]*)$/),
)

const Rfc3339Timestamp = Schema.String.check(
	Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/),
)

export const StringSignalScalar = Schema.Struct({
	type: Schema.Literal("string"),
	value: Schema.String,
})

const StringLiteralValue = Schema.String.annotate({
	description: `Predicate string literal limited to ${MAX_STRING_LITERAL_BYTES} UTF-8 bytes; JSON Schema cannot express this byte-count constraint`,
}).check(
	Schema.makeFilter((value) => utf8Bytes(value) <= MAX_STRING_LITERAL_BYTES, {
		expected: `a string no larger than ${MAX_STRING_LITERAL_BYTES} UTF-8 bytes`,
		description: `Predicate string literal limited to ${MAX_STRING_LITERAL_BYTES} UTF-8 bytes`,
	}),
)

export const StringSignalLiteral = Schema.Struct({
	type: Schema.Literal("string"),
	value: StringLiteralValue,
})

export const BooleanSignalScalar = Schema.Struct({
	type: Schema.Literal("boolean"),
	value: Schema.Boolean,
})

export const Int64SignalScalar = Schema.Struct({
	type: Schema.Literal("int64"),
	value: DecimalInt64,
})

export const Float64SignalScalar = Schema.Struct({
	type: Schema.Literal("float64"),
	value: Schema.Finite,
})

export const TimestampSignalScalar = Schema.Struct({
	type: Schema.Literal("timestamp"),
	value: Rfc3339Timestamp,
})

export const DurationSignalScalar = Schema.Struct({
	type: Schema.Literal("duration"),
	value: DecimalInt64,
})

export const SignalScalarSchema = Schema.Union([
	StringSignalScalar,
	BooleanSignalScalar,
	Int64SignalScalar,
	Float64SignalScalar,
	TimestampSignalScalar,
	DurationSignalScalar,
]).annotate({ identifier: "SignalScalar" })
export type SignalScalar = Schema.Schema.Type<typeof SignalScalarSchema>
export type SignalScalarType = SignalScalar["type"]

export const SignalLiteralSchema = Schema.Union([
	StringSignalLiteral,
	BooleanSignalScalar,
	Int64SignalScalar,
	Float64SignalScalar,
	TimestampSignalScalar,
	DurationSignalScalar,
]).annotate({ identifier: "SignalLiteral" })
export type SignalLiteral = Schema.Schema.Type<typeof SignalLiteralSchema>

export const FieldNamespaceSchema = Schema.Literals(["signal", "resource", "scope", "attribute", "body"])
export type FieldNamespace = Schema.Schema.Type<typeof FieldNamespaceSchema>

export const FieldRefSchema = Schema.Struct({
	namespace: FieldNamespaceSchema,
	key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
	type: Schema.Literals(["string", "boolean", "int64", "float64", "timestamp", "duration"]),
}).annotate({ identifier: "SignalFieldRef" })
export type FieldRef = Schema.Schema.Type<typeof FieldRefSchema>

export interface AllPredicate {
	readonly op: "all"
	readonly clauses: readonly SignalPredicate[]
}

export interface AnyPredicate {
	readonly op: "any"
	readonly clauses: readonly SignalPredicate[]
}

export interface NotPredicate {
	readonly op: "not"
	readonly clause: SignalPredicate
}

export interface ExistsPredicate {
	readonly op: "exists"
	readonly field: FieldRef
}

export interface ComparisonPredicate {
	readonly op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains"
	readonly field: FieldRef
	readonly value: SignalLiteral
}

export interface InPredicate {
	readonly op: "in"
	readonly field: FieldRef
	readonly values: readonly SignalLiteral[]
}

export type SignalPredicate =
	| AllPredicate
	| AnyPredicate
	| NotPredicate
	| ExistsPredicate
	| ComparisonPredicate
	| InPredicate

export const SignalPredicateSchema: Schema.Codec<SignalPredicate, SignalPredicate> = Schema.suspend(
	(): Schema.Codec<SignalPredicate, SignalPredicate> =>
		Schema.Union([
			Schema.Struct({
				op: Schema.Literal("all"),
				clauses: Schema.Array(SignalPredicateSchema).check(
					Schema.isMinLength(1),
					Schema.isMaxLength(MAX_PREDICATE_NODES),
				),
			}),
			Schema.Struct({
				op: Schema.Literal("any"),
				clauses: Schema.Array(SignalPredicateSchema).check(
					Schema.isMinLength(1),
					Schema.isMaxLength(MAX_PREDICATE_NODES),
				),
			}),
			Schema.Struct({
				op: Schema.Literal("not"),
				clause: SignalPredicateSchema,
			}),
			Schema.Struct({
				op: Schema.Literal("exists"),
				field: FieldRefSchema,
			}),
			Schema.Struct({
				op: Schema.Literals(["eq", "neq", "gt", "gte", "lt", "lte", "contains"]),
				field: FieldRefSchema,
				value: SignalLiteralSchema,
			}),
			Schema.Struct({
				op: Schema.Literal("in"),
				field: FieldRefSchema,
				values: Schema.Array(SignalLiteralSchema).check(
					Schema.isMinLength(1),
					Schema.isMaxLength(MAX_IN_VALUES),
				),
			}),
		]) as Schema.Codec<SignalPredicate, SignalPredicate>,
).annotate({ identifier: "SignalPredicate" })

export const ProjectorRefSchema = Schema.Struct({
	id: NonEmptyIdentifier,
	version: Schema.Int.check(Schema.isGreaterThan(0)),
	config: Schema.Unknown,
})
export type ProjectorRef = Schema.Schema.Type<typeof ProjectorRefSchema>

export const SignalProjectionSpecSchema = Schema.Struct({
	id: NonEmptyIdentifier,
	revision: Schema.Int.check(Schema.isGreaterThan(0)),
	enabled: Schema.Boolean,
	tenantId: NonEmptyIdentifier,
	sourceKind: NonEmptyIdentifier,
	selector: SignalPredicateSchema,
	projector: ProjectorRefSchema,
	activeFrom: Rfc3339Timestamp,
}).annotate({ identifier: "SignalProjectionSpec" })
export type SignalProjectionSpec = Schema.Schema.Type<typeof SignalProjectionSpecSchema>

export interface NormalizedSignal<TData = unknown> {
	readonly sourceKind: string
	readonly source: string
	readonly tenantId: string
	readonly occurrenceId: string | null
	readonly identityQuality: "source" | "derived" | "none"
	readonly occurredAt: string
	readonly observedAt: string
	readonly subject: string | null
	readonly fields: ReadonlyMap<string, SignalScalar>
	readonly data: TData
}

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[]

export interface ProjectedEventData {
	readonly subject?: string | null
	readonly time?: string
	readonly data: JsonValue
}

export interface MapleCloudEvent {
	readonly specversion: "1.0"
	readonly id: string
	readonly source: string
	readonly type: string
	readonly subject?: string
	readonly time: string
	readonly datacontenttype: "application/json"
	readonly dataschema: string
	readonly tenantid: string
	readonly projectionid: string
	readonly projectionrevision: number
	readonly projectorid: string
	readonly projectorversion: number
	readonly data: JsonValue
}

export const MapleCloudEventSchema = Schema.Struct({
	specversion: Schema.Literal("1.0"),
	id: NonEmptyIdentifier,
	source: NonEmptyIdentifier,
	type: NonEmptyIdentifier,
	subject: Schema.optionalKey(Schema.String),
	time: Rfc3339Timestamp,
	datacontenttype: Schema.Literal("application/json"),
	dataschema: NonEmptyIdentifier,
	tenantid: NonEmptyIdentifier,
	projectionid: NonEmptyIdentifier,
	projectionrevision: Schema.Int.check(Schema.isGreaterThan(0)),
	projectorid: NonEmptyIdentifier,
	projectorversion: Schema.Int.check(Schema.isGreaterThan(0)),
	data: Schema.Unknown,
}).annotate({ identifier: "MapleCloudEvent" })

export const fieldKey = (field: Pick<FieldRef, "namespace" | "key">): string =>
	`${field.namespace}:${field.key}`

export const defineSignalFields = (
	fields: ReadonlyArray<{ readonly field: FieldRef; readonly value: SignalScalar }>,
): ReadonlyMap<string, SignalScalar> =>
	new Map(fields.map(({ field, value }) => [fieldKey(field), value] as const))
