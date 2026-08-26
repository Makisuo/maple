// DSL errors
//
// Their own module because both `expr.ts` (literal encoding) and `compile.ts`
// (param resolution, orderBy validation) raise them, and `expr → compile` would
// close the `expr → compile → query → expr` cycle. That cycle survives today
// only because everything crossing it is a hoisted `function` declaration —
// one top-level `const` away from a TDZ crash in the bundle.

import { Schema } from "effect"

/** Invariant violations in the DSL, thrown synchronously while building SQL. */
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
		]),
		message: Schema.String,
	},
) {}
