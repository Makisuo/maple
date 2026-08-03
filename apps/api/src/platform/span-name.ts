import { Effect } from "effect"

/**
 * Rename the span that is currently open.
 *
 * WHY THIS EXISTS: OTel's database conventions want a DB client span *named*
 * after the query it ran ("SELECT alert_rules") — Maple's own read path says so
 * at `@maple/domain/tinybird/db-query-shape-sql`, where `SpanName` is the
 * "silent last resort (non-conformant naming)". But `Database.execute` takes an
 * opaque callback, so the SQL only becomes known once drizzle's `logger` fires,
 * which is *after* the span has opened. Effect v4 fixes a span's name at
 * creation (`Effect.withSpan`/`Effect.fn` take a plain string) and, unlike the
 * OTel JS API, exposes no `updateName`.
 *
 * WHY IT'S SAFE TODAY: `Tracer.Span.name` is `readonly` at the type level only.
 * `Effect.currentSpan` hands back the live span instance (not a copy — that is
 * how `annotateCurrentSpan` mutates attributes), and both span implementations
 * we run against store `name` as an ordinary writable property:
 *   - `Tracer.NativeSpan` (tests) assigns it in its constructor;
 *   - Maple's `SpanImpl` (`@maple-dev/effect-sdk`, the deployed tracer) spreads
 *     options onto the object and reads `self.name` when building the OTLP
 *     payload inside `end()` — i.e. at span *end*, so a mid-span rename ships.
 *
 * WHY IT'S CONTAINED HERE: this is the one place in the repo that writes a
 * readonly Tracer field, so there is one cast to review rather than a scattered
 * pattern. `span-name.test.ts` asserts the rename reaches the tracer's recorded
 * span; if an Effect upgrade freezes spans or caches the name at start, that
 * test fails loudly instead of every DB span silently reverting to its
 * placeholder name.
 *
 * No-ops when there is no current span (e.g. an untraced fiber).
 */
export const updateCurrentSpanName = (name: string): Effect.Effect<void> =>
	Effect.currentSpan.pipe(
		Effect.flatMap((span) =>
			Effect.sync(() => {
				;(span as { name: string }).name = name
			}),
		),
		Effect.ignore,
	)
