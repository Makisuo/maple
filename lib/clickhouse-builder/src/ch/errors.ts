// DSL errors
//
// Their own module because both `expr.ts` (literal encoding) and `compile.ts`
// (param resolution, orderBy validation) raise them, and `expr → compile` would
// close the `expr → compile → query → expr` cycle. That cycle survives today
// only because everything crossing it is a hoisted `function` declaration —
// one top-level `const` away from a TDZ crash in the bundle.

import { Schema } from "effect"

/**
 * Failures the builder reports, as opposed to defects it dies on.
 *
 * The line between the two is what a runtime value can reach:
 *
 * - A `QueryBuilderError` describes a **value** the builder was handed and
 *   cannot turn into SQL — a param with no value or the wrong type, an operand
 *   a column's codec rejects, a set of arguments whose *size* came from data (a
 *   funnel with no steps), a pattern string that would break out of its quotes.
 *   Code that assembles a query from a request body can hit every one of these
 *   with correct code and bad input, so they belong in the Effect error
 *   channel: `compile` turns a thrown one into a typed failure.
 *
 * - A {@link QueryBuilderDefect} describes a **call** that could not be right
 *   for any value — a param name that is not an identifier, a placeholder
 *   compared as if it were already resolved, two column types claiming one
 *   ClickHouse type name. No input reaches these; only a rewrite does. They
 *   stay defects, so nobody pattern-matches on a bug.
 */
export class QueryBuilderError extends Schema.TaggedError<QueryBuilderError>()(
	"@maple-dev/clickhouse-builder/QueryBuilderError",
	{
		code: Schema.Literals([
			"SelectRequired",
			"UnresolvedParam",
			"InvalidOrderBySpec",
			"InvalidParamName",
			"InvalidParamValue",
			"InvalidLiteral",
			"InvalidArguments",
		]),
		message: Schema.String,
	},
) {}

/**
 * A DSL misuse — see the rule on {@link QueryBuilderError}.
 *
 * A separate class rather than another `QueryBuilderError` code, because the
 * class is what decides the channel: `compile` maps a thrown
 * `QueryBuilderError` into the error channel and dies on everything else, so
 * this one reaches callers as a defect in the `Cause` — where a bug belongs and
 * where no `catchTag` can quietly swallow it.
 */
export class QueryBuilderDefect extends Schema.TaggedError<QueryBuilderDefect>()(
	"@maple-dev/clickhouse-builder/QueryBuilderDefect",
	{ message: Schema.String },
) {}
