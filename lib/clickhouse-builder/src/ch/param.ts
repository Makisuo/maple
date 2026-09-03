// Query Parameters
//
// Params are placeholder expressions whose values are resolved at compile
// time (not at SQL execution time). They carry their name and type as
// phantom types so the query's Params type can be inferred.

import { type DateTime, Schema } from "effect"
import type { SqlFragment } from "../sql/sql-fragment"
import { raw } from "../sql/sql-fragment"
import type { Expr } from "./expr"
import { QueryBuilderDefect } from "./errors"
import * as T from "./types"
import type { CHType } from "./types"

/**
 * What a param's value must be, carried in the placeholder so `compile` can
 * check the value it is handed instead of stringifying whatever arrives.
 *
 * A kind names a *codec*, not a special case: `paramType` below maps each to
 * the column type whose schema encodes it, which is the same schema a column of
 * that type decodes rows with. `param.of` registers further ones at runtime, so
 * a custom column type works as a param without touching this union.
 */
export type ParamKind = string

/**
 * The placeholder text a param compiles to: `__PARAM_<kind>_<name>__`.
 *
 * Exported for handwritten SQL fragments that are spliced into a builder query
 * and resolved by its `compile` — building the string by hand would couple your
 * code to this format, and a malformed one is indistinguishable from a param
 * nobody supplied.
 */
export const paramPlaceholder = (kind: ParamKind, name: string): string => {
	assertValidParamName(name)
	return `${PARAM_MARKER_PREFIX}${kind}_${name}__`
}

/**
 * The text every placeholder starts with — the one substring that must never
 * appear in rendered SQL except as a real marker. `escapeClickHouseString`
 * hex-escapes it out of user values for exactly that reason, and `compile`
 * checks for it as a post-condition once params are resolved.
 */
export const PARAM_MARKER_PREFIX = "__PARAM_"

export const PARAM_PLACEHOLDER_PATTERN = /__PARAM_([A-Za-z][A-Za-z0-9]*)_(.+?)__/g

/**
 * Names travel through the placeholder, so they have to survive the round trip:
 * `__` would make the boundary ambiguous and an empty name unmatchable.
 *
 * A defect, not a failure: a param name is written in the query definition, so
 * no runtime value can produce a bad one. See the rule on `QueryBuilderError`.
 */
function assertValidParamName(name: string): void {
	if (!/^[A-Za-z0-9$]+(?:_[A-Za-z0-9$]+)*$/.test(name)) {
		throw new QueryBuilderDefect({
			message: `param name ${JSON.stringify(name)} must be alphanumeric, optionally separated by single underscores`,
		})
	}
}

// Param marker — used during query definition (before compilation)

export interface ParamMarker<N extends string, T> extends Expr<T> {
	readonly _paramName: N
	readonly _paramType?: T
}

/**
 * Every comparison on a marker is the same mistake: a placeholder is not a
 * value, so `param.string("x").eq(y)` has nothing to compare. Compare the
 * *column* against the param instead — `$.OrgId.eq(param.string("orgId"))`.
 *
 * A defect rather than a failure for the same reason `assertValidParamName` is:
 * which side of the comparison the param sits on is written in the source.
 */
const unresolved = (name: string) => (): never => {
	throw new QueryBuilderDefect({
		message: `param '${name}' is a placeholder, not a value — compare a column against it (\`$.Col.eq(param.string('${name}'))\`) rather than comparing on the param`,
	})
}

function makeParamMarker<N extends string, T>(name: N, fragment: SqlFragment): ParamMarker<N, T> {
	const raise = unresolved(name)
	return {
		_brand: "Expr" as const,
		_paramName: name,
		toFragment: () => fragment,
		eq: raise,
		neq: raise,
		gt: raise,
		gte: raise,
		lt: raise,
		lte: raise,
		like: raise,
		notLike: raise,
		ilike: raise,
		div: raise,
		mul: raise,
		add: raise,
		sub: raise,
		mod: raise,
		in_: raise,
		notIn: raise,
	} as ParamMarker<N, T>
}

// Param constructors (used in query definitions)

/**
 * The codec behind each param kind.
 *
 * `int` and `float` are the two shapes of a number that ClickHouse tells apart:
 * a fractional value in an integer position is a silent `Math.round` at best,
 * so the integer kind refuses one and points at the other.
 */
const CHSafeInteger = Schema.Number.pipe(
	Schema.check(
		Schema.makeFilter(
			(value: number) =>
				Number.isSafeInteger(value)
					? undefined
					: `${value} is not a safe integer (use param.float for fractions)`,
			{ title: "safeInteger" },
		),
	),
)

const paramTypes = new Map<ParamKind, Schema.Codec<any, any>>([
	["string", T.string.literalSchema],
	["int", CHSafeInteger],
	["float", T.float64.literalSchema],
	["bool", T.bool.literalSchema],
	["dateTime", T.dateTime.literalSchema],
	["dateTimeSeconds", T.CHDateTimeSecondsLiteral],
])

/** The codec a placeholder's kind names, or `undefined` for an unknown kind. */
export const paramSchema = (kind: ParamKind): Schema.Codec<any, any> | undefined => paramTypes.get(kind)

const makeParam =
	<T>(kind: ParamKind) =>
	<N extends string>(name: N): ParamMarker<N, T> => {
		assertValidParamName(name)
		return makeParamMarker<N, T>(name, raw(paramPlaceholder(kind, name)))
	}

/** A kind slug for a custom column type: its ClickHouse type name, made safe
 *  for the placeholder grammar (`Map(String, String)` → `MapStringString`). */
const kindFor = (type: CHType<string, any, any>): ParamKind => type.sql.replace(/[^A-Za-z0-9]/g, "")

export const param = {
	/** Resolved from a string; emitted as an escaped SQL literal. */
	string: makeParam<string>("string"),

	/** Resolved from an integer (or bigint). A fractional value is rejected
	 *  rather than silently rounded — reach for `param.float` when you mean one. */
	int: makeParam<number>("int"),

	/** Resolved from any finite number. */
	float: makeParam<number>("float"),

	/** Resolved from a boolean; emitted as ClickHouse's `1` / `0`. */
	bool: makeParam<boolean>("bool"),

	/**
	 * Resolved from a `'YYYY-MM-DD hh:mm:ss'` string, a `Date`, or a
	 * `DateTime.Utc`.
	 *
	 * Typed as a `DateTime.Utc` expression so it compares against DateTime
	 * columns and not against everything. For a column declared as
	 * `dateTimeString`, use {@link param.dateTimeString}.
	 */
	dateTime: makeParam<DateTime.Utc>("dateTime"),

	/**
	 * The same bound, typed for a column declared as `dateTimeString`.
	 *
	 * Identical at runtime — the flavours differ only in what the row decodes to,
	 * and a param has to agree with the column it bounds.
	 */
	dateTimeString: makeParam<string>("dateTime"),

	/**
	 * The same bound, floored to whole seconds.
	 *
	 * For a column declared `DateTime` (not `DateTime64`) that shares a param with
	 * a `DateTime64` column beside it — `logs.TimestampTime` next to
	 * `logs.Timestamp`, `trace_list_mv.Timestamp` next to `traces.Timestamp`. The
	 * fraction is load-bearing on the 64-bit column (a log search can legitimately
	 * span 200ms) and a hard `TYPE_MISMATCH` on the other, so one rendering cannot
	 * serve both. Placeholders carry kind and name independently, so this reads the
	 * very same `startTime` value and only encodes it differently.
	 *
	 * Widening is safe where these appear: they bound a partition/index key for
	 * pruning, and the exact `DateTime64` predicate still decides the result.
	 */
	dateTimeSeconds: makeParam<string>("dateTimeSeconds"),

	/**
	 * A param of any column type, resolved through that type's own codec.
	 *
	 * The five above are the common cases; this is how a type you declared
	 * yourself — an enum, a decimal, a branded id — becomes a param without the
	 * builder needing to know about it.
	 */
	of: <T, N extends string>(type: CHType<string, T, any>, name: N): ParamMarker<N, T> => {
		const kind = kindFor(type)
		const registered = paramTypes.get(kind)
		if (registered === undefined) paramTypes.set(kind, type.literalSchema)
		else if (registered !== type.literalSchema) {
			// A defect: both types are declared in the source, so no input can
			// cause or avoid the collision.
			throw new QueryBuilderDefect({
				message: `param.of: two different types both compile to '${type.sql}' — give one of them a distinct ClickHouse type name`,
			})
		}
		return makeParam<T>(kind)(name)
	},
}
