import { Effect } from "effect"

/**
 * Expected-outcome handling for the root `maple` span.
 *
 * A CLI failure is not automatically a *problem*. Refusing to start because the
 * server is already running, reporting that no backend is configured, printing
 * `--help` — these are the CLI working, but they travel through Effect's error
 * channel, so `Effect.withSpan("maple", …)` in bin.ts closed the root span
 * `Error` for every one of them. They were the CLI's top error sources by a wide
 * margin (~24k events for the already-running guard alone) and buried the
 * failures worth acting on.
 *
 * These helpers recover such outcomes *inside* the span — the same placement
 * bin.ts already uses for `ArchiveError`, and for the same reason: applied
 * outside, the span has already closed by the time recovery runs.
 *
 * They live in their own module because bin.ts executes the CLI at import time
 * and cannot be imported by a test.
 */

/** Record which expected outcome ended the run, on the root `maple` span. */
export const annotateOutcome = (tag: string): Effect.Effect<void> =>
	Effect.annotateCurrentSpan({ "maple.cli.outcome": tag })

/**
 * Recover an expected, user-facing outcome: annotate it, print its message, and
 * exit non-zero while leaving the root span `Ok`.
 *
 * `runMain` would otherwise render the failure itself, so the message has to be
 * written here — the exit status and stderr output the user sees are unchanged.
 */
export const recoverExpected = (error: {
	readonly _tag: string
	readonly message: string
}): Effect.Effect<void> =>
	annotateOutcome(error._tag).pipe(
		Effect.andThen(
			Effect.sync(() => {
				process.stderr.write(`${error.message}\n`)
				process.exitCode = 1
			}),
		),
	)
