import type {
	FieldRef,
	NormalizedSignal,
	SignalPredicate,
	SignalProjectionSpec,
	SignalScalar,
	SignalScalarType,
} from "./model"
import { fieldKey } from "./model"

export const MAX_PREDICATE_DEPTH = 8
export const MAX_PREDICATE_NODES = 64
export const MAX_IN_VALUES = 100
export const MAX_STRING_LITERAL_BYTES = 4 * 1024

const INT64_MIN = -(1n << 63n)
const INT64_MAX = (1n << 63n) - 1n
const ORDERED_TYPES = new Set<SignalScalarType>(["int64", "float64", "timestamp", "duration"])

export interface ValidationIssue {
	readonly path: string
	readonly message: string
}

export class SignalPredicateValidationError extends Error {
	readonly issues: readonly ValidationIssue[]

	constructor(issues: readonly ValidationIssue[]) {
		super(issues.map(({ path, message }) => `${path}: ${message}`).join("; "))
		this.name = "SignalPredicateValidationError"
		this.issues = issues
	}
}

const stringBytes = (value: string): number => new TextEncoder().encode(value).byteLength

const parseInt64 = (value: string): bigint | null => {
	try {
		const parsed = BigInt(value)
		return parsed >= INT64_MIN && parsed <= INT64_MAX ? parsed : null
	} catch {
		return null
	}
}

const isLeapYear = (year: number): boolean => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)

const daysInMonth = (year: number, month: number): number => {
	switch (month) {
		case 2:
			return isLeapYear(year) ? 29 : 28
		case 4:
		case 6:
		case 9:
		case 11:
			return 30
		default:
			return 31
	}
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/

/** Parse the v1 RFC 3339 subset into exact UTC nanoseconds. */
export const timestampToEpochNanos = (value: string): bigint | null => {
	const match = TIMESTAMP.exec(value)
	if (!match) return null
	const year = Number(match[1])
	const month = Number(match[2])
	const day = Number(match[3])
	const hour = Number(match[4])
	const minute = Number(match[5])
	const second = Number(match[6])
	const fraction = match[7] ?? ""
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > daysInMonth(year, month) ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	)
		return null

	let offsetMinutes = 0
	if (match[8] !== "Z") {
		const offsetHours = Number(match[10])
		const offsetMinutePart = Number(match[11])
		if (offsetHours > 23 || offsetMinutePart > 59) return null
		offsetMinutes = offsetHours * 60 + offsetMinutePart
		if (match[9] === "-") offsetMinutes = -offsetMinutes
	}

	const date = new Date(0)
	date.setUTCFullYear(year, month - 1, day)
	date.setUTCHours(hour, minute, second, 0)
	const milliseconds = date.getTime() - offsetMinutes * 60_000
	if (!Number.isFinite(milliseconds)) return null
	const nanos = BigInt(fraction.padEnd(9, "0"))
	return BigInt(milliseconds) * 1_000_000n + nanos
}

export const validateSignalScalar = (scalar: SignalScalar, path = "value"): readonly ValidationIssue[] => {
	const issues: ValidationIssue[] = []
	switch (scalar.type) {
		case "string":
			if (stringBytes(scalar.value) > MAX_STRING_LITERAL_BYTES)
				issues.push({ path, message: `string exceeds ${MAX_STRING_LITERAL_BYTES} UTF-8 bytes` })
			break
		case "boolean":
			break
		case "int64":
		case "duration":
			if (parseInt64(scalar.value) === null)
				issues.push({ path, message: `${scalar.type} must be a signed 64-bit decimal integer` })
			break
		case "float64":
			if (!Number.isFinite(scalar.value)) issues.push({ path, message: "float64 must be finite" })
			break
		case "timestamp":
			if (timestampToEpochNanos(scalar.value) === null)
				issues.push({
					path,
					message: "timestamp must be a valid RFC 3339 instant with an explicit offset",
				})
			break
	}
	return issues
}

export const validateSignalPredicate = (predicate: SignalPredicate): readonly ValidationIssue[] => {
	const issues: ValidationIssue[] = []
	let nodes = 0

	const visit = (node: SignalPredicate, path: string, depth: number): void => {
		nodes += 1
		if (nodes > MAX_PREDICATE_NODES) return
		if (depth > MAX_PREDICATE_DEPTH) {
			issues.push({ path, message: `predicate depth exceeds ${MAX_PREDICATE_DEPTH}` })
			return
		}

		switch (node.op) {
			case "all":
			case "any":
				if (node.clauses.length === 0)
					issues.push({
						path: `${path}.clauses`,
						message: `${node.op} requires at least one clause`,
					})
				for (let i = 0; i < node.clauses.length; i++)
					visit(node.clauses[i]!, `${path}.clauses[${i}]`, depth + 1)
				break
			case "not":
				visit(node.clause, `${path}.clause`, depth + 1)
				break
			case "exists":
				break
			case "contains":
				if (node.field.type !== "string" || node.value.type !== "string")
					issues.push({ path, message: "contains requires a string field and string literal" })
				issues.push(...validateSignalScalar(node.value, `${path}.value`))
				break
			case "gt":
			case "gte":
			case "lt":
			case "lte":
				if (!ORDERED_TYPES.has(node.field.type))
					issues.push({ path, message: `${node.op} is not supported for ${node.field.type}` })
				if (node.field.type !== node.value.type)
					issues.push({ path, message: "field and literal types must match" })
				issues.push(...validateSignalScalar(node.value, `${path}.value`))
				break
			case "eq":
			case "neq":
				if (node.field.type !== node.value.type)
					issues.push({ path, message: "field and literal types must match" })
				issues.push(...validateSignalScalar(node.value, `${path}.value`))
				break
			case "in":
				if (node.values.length === 0)
					issues.push({ path: `${path}.values`, message: "in requires at least one value" })
				if (node.values.length > MAX_IN_VALUES)
					issues.push({ path: `${path}.values`, message: `in exceeds ${MAX_IN_VALUES} values` })
				for (let i = 0; i < node.values.length; i++) {
					const value = node.values[i]!
					if (value.type !== node.field.type)
						issues.push({
							path: `${path}.values[${i}]`,
							message: "field and literal types must match",
						})
					issues.push(...validateSignalScalar(value, `${path}.values[${i}]`))
				}
				break
		}
	}

	visit(predicate, "selector", 1)
	if (nodes > MAX_PREDICATE_NODES)
		issues.push({ path: "selector", message: `predicate exceeds ${MAX_PREDICATE_NODES} nodes` })
	return issues
}

export const assertValidSignalPredicate = (predicate: SignalPredicate): void => {
	const issues = validateSignalPredicate(predicate)
	if (issues.length > 0) throw new SignalPredicateValidationError(issues)
}

export const validateSignalProjectionSpec = (
	projection: SignalProjectionSpec,
): readonly ValidationIssue[] => [
	...(timestampToEpochNanos(projection.activeFrom) === null
		? [{ path: "activeFrom", message: "must be a valid RFC 3339 instant with an explicit offset" }]
		: []),
	...validateSignalPredicate(projection.selector),
]

export interface PredicateEvaluation {
	readonly matches: boolean
	readonly typeMismatches: readonly FieldRef[]
}

const scalarEquals = (left: SignalScalar, right: SignalScalar): boolean => {
	if (left.type !== right.type) return false
	switch (left.type) {
		case "string":
			return right.type === "string" && left.value === right.value
		case "boolean":
			return right.type === "boolean" && left.value === right.value
		case "float64":
			return right.type === "float64" && left.value === right.value
		case "int64":
			return right.type === "int64" && BigInt(left.value) === BigInt(right.value)
		case "duration":
			return right.type === "duration" && BigInt(left.value) === BigInt(right.value)
		case "timestamp":
			return (
				right.type === "timestamp" &&
				timestampToEpochNanos(left.value) === timestampToEpochNanos(right.value)
			)
	}
}

const scalarOrder = (left: SignalScalar, right: SignalScalar): number | null => {
	if (left.type !== right.type || !ORDERED_TYPES.has(left.type)) return null
	switch (left.type) {
		case "int64": {
			if (right.type !== "int64") return null
			const a = BigInt(left.value)
			const b = BigInt(right.value)
			return a < b ? -1 : a > b ? 1 : 0
		}
		case "duration": {
			if (right.type !== "duration") return null
			const a = BigInt(left.value)
			const b = BigInt(right.value)
			return a < b ? -1 : a > b ? 1 : 0
		}
		case "float64":
			return right.type !== "float64"
				? null
				: left.value < right.value
					? -1
					: left.value > right.value
						? 1
						: 0
		case "timestamp": {
			if (right.type !== "timestamp") return null
			const a = timestampToEpochNanos(left.value)!
			const b = timestampToEpochNanos(right.value)!
			return a < b ? -1 : a > b ? 1 : 0
		}
		default:
			return null
	}
}

export type CompiledSignalPredicate = (signal: NormalizedSignal) => PredicateEvaluation

export const compileSignalPredicate = (predicate: SignalPredicate): CompiledSignalPredicate => {
	assertValidSignalPredicate(predicate)

	return (signal) => {
		const typeMismatches: FieldRef[] = []
		const readField = (field: FieldRef): SignalScalar | undefined => {
			const value = signal.fields.get(fieldKey(field))
			if (value === undefined) return undefined
			if (value.type !== field.type || validateSignalScalar(value).length > 0) {
				typeMismatches.push(field)
				return undefined
			}
			return value
		}

		const evaluate = (node: SignalPredicate): boolean => {
			switch (node.op) {
				case "all":
					return node.clauses.every(evaluate)
				case "any":
					return node.clauses.some(evaluate)
				case "not":
					return !evaluate(node.clause)
				case "exists": {
					return readField(node.field) !== undefined
				}
				case "eq":
				case "neq":
				case "gt":
				case "gte":
				case "lt":
				case "lte":
				case "contains": {
					const value = readField(node.field)
					if (value === undefined) return false
					if (node.op === "eq") return scalarEquals(value, node.value)
					if (node.op === "neq") return !scalarEquals(value, node.value)
					if (node.op === "contains")
						return (
							value.type === "string" &&
							node.value.type === "string" &&
							value.value.includes(node.value.value)
						)
					const order = scalarOrder(value, node.value)
					if (order === null) return false
					if (node.op === "gt") return order > 0
					if (node.op === "gte") return order >= 0
					if (node.op === "lt") return order < 0
					return order <= 0
				}
				case "in": {
					const value = readField(node.field)
					if (value === undefined) return false
					return node.values.some((candidate) => scalarEquals(value, candidate))
				}
			}
		}

		return { matches: evaluate(predicate), typeMismatches }
	}
}
