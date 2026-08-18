import { Schema } from "effect"

/**
 * The message a caller shows when every query ran but none returned rows.
 *
 * Exported as a constant because the alert-preview path string-matches it to
 * tell "your range is empty" (a muted, expected state) apart from "your query is
 * broken" (a red error card). Changing the text without changing that match
 * would turn every empty preview back into an error.
 */
export const NO_QUERY_DATA_MESSAGE = "No query data found in selected time range"

/**
 * The query set cannot produce a result as described — nothing to execute, or
 * nothing left to draw once hidden series are removed.
 *
 * Distinct from a warehouse failure: the input is the problem, and retrying it
 * unchanged will fail the same way.
 */
export class QuerySetInputError extends Schema.TaggedError<QuerySetInputError>()(
	"@maple/query-engine/query-set/QuerySetInputError",
	{
		operation: Schema.String,
		message: Schema.String,
	},
) {}

/**
 * Every query ran and none of them returned data for the window.
 *
 * Its own tag rather than a flavour of `QuerySetInputError` because it is not a
 * fault — an empty window is a normal answer — and callers render it as a muted
 * "No data" state rather than an error.
 */
export class QuerySetNoDataError extends Schema.TaggedError<QuerySetNoDataError>()(
	"@maple/query-engine/query-set/QuerySetNoDataError",
	{
		message: Schema.String,
		/** Per-query messages, when a query failed rather than simply returning nothing. */
		details: Schema.Array(Schema.String),
	},
) {}
