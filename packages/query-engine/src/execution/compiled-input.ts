import { Effect } from "effect"
import type { CompiledQuery, CompiledQueryInput } from "../ch"

/**
 * Run an unrun `CH.compile`, or pass an already-compiled query through.
 *
 * The one place that decides what a `QueryBuilderError` means on the execution
 * path, so no caller has to: a query reaching an executor is built from Maple's
 * own definitions, and a definition that disagrees with its params is a bug,
 * not a condition to report. A caller whose params carry wire values answers
 * for that failure before handing the compile over — see `CompiledQueryInput`.
 *
 * Exported because every stand-in for a warehouse — a test double, the SQL
 * catalog's capturing warehouse — needs the same step before it can read `.sql`.
 */
export const resolveCompiledQuery = <T>(
	input: CompiledQueryInput<T>,
): Effect.Effect<CompiledQuery<T>> =>
	// `sql` is what a compiled query has and an unrun compile does not, which is
	// enough to narrow — and cheaper to read than a runtime Effect check, which
	// would need a cast to keep `T`.
	"sql" in input ? Effect.succeed(input) : Effect.orDie(input)

/**
 * The compiled query behind an input, without an Effect to run it in.
 *
 * For the callers standing outside the execution path — a double replacing the
 * executor in a test, the SQL catalog's capturing warehouse — that still have
 * to read `.sql` or decode rows. Running it is safe: resolving has no failure
 * channel and needs no services, and a compile that does fail dies exactly
 * where it would have inside the executor.
 */
export const compiledQueryOf = <T>(input: CompiledQueryInput<T>): CompiledQuery<T> =>
	Effect.runSync(resolveCompiledQuery(input))
