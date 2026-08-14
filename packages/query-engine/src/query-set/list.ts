/**
 * The list path: raw rows from the first enabled query.
 *
 * Single-query by construction. A list has no value axis to merge on, so N
 * queries would produce N unrelated tables rather than one — the builder UI
 * reflects that by only ever offering one query for a list panel.
 */

import { Effect } from "effect"
import type { QuerySet } from "@maple/query-model"
import { buildListQuerySpec } from "../query-builder/model"
import { QuerySetInputError } from "./errors"
import type { QuerySetExecutor } from "./port"

export interface ListQuerySetResult {
	readonly rows: ReadonlyArray<Record<string, unknown>>
}

export interface RunListQuerySetInput {
	readonly querySet: QuerySet
	readonly startTime: string
	readonly endTime: string
	readonly limit?: number
	readonly columns?: ReadonlyArray<string>
}

const OPERATION = "runListQuerySet"

export const runListQuerySet = Effect.fnUntraced(function* <E>(
	executor: QuerySetExecutor<E>,
	input: RunListQuerySetInput,
) {
	const enabledQueries = input.querySet.queries.filter((query) => query.enabled !== false)
	const query = enabledQueries[0]
	if (query === undefined) {
		return yield* new QuerySetInputError({
			operation: OPERATION,
			message: "No enabled queries to run",
		})
	}

	const built = buildListQuerySpec(
		query,
		input.limit,
		input.columns === undefined ? undefined : [...input.columns],
	)

	if (!built.query) {
		return yield* new QuerySetInputError({
			operation: OPERATION,
			message: built.error ?? "Failed to build list query",
		})
	}

	const result = yield* executor.execute({
		startTime: input.startTime,
		endTime: input.endTime,
		query: built.query,
	})

	// Unlike breakdown, a wrong result kind here fails outright: there is only one
	// query, so there is no sibling whose data would be lost by failing.
	if (result.kind !== "list") {
		return yield* new QuerySetInputError({
			operation: OPERATION,
			message: `Unexpected result kind: ${result.kind}`,
		})
	}

	return { rows: result.data } satisfies ListQuerySetResult
})
