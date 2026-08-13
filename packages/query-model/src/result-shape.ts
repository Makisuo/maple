/**
 * What a query set is asked to return.
 *
 * Carried alongside the queries rather than encoded in a per-shape union: a
 * widget switching from a timeseries to a breakdown keeps the same drafts, and
 * a union keyed on the shape would turn that switch into a decode failure for
 * any key the new arm doesn't declare.
 */
export const QUERY_RESULT_SHAPES = ["timeseries", "breakdown", "list"] as const
export type QueryResultShape = (typeof QUERY_RESULT_SHAPES)[number]
