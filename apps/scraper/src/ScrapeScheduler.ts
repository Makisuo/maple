import {
	Cause,
	Clock,
	Context,
	Duration,
	Effect,
	Fiber,
	Layer,
	Metric,
	Ref,
	Result,
	Schedule,
	Schema,
	Semaphore,
} from "effect"
import { ScrapeResultReport, type InternalScrapeTarget } from "@maple/domain/http"
import { ApiClient, ApiRequestError } from "./ApiClient"
import { convertFamiliesToOtlp } from "./prometheus/otlp"
import { parsePrometheusText } from "./prometheus/parser"
import { OtlpIngest } from "./OtlpIngest"
import { ScraperEnv } from "./Env"
import { activeTargets, bufferedResults, scrapeDurationMs, scrapesTotal } from "./Metrics"

interface SchedulerStats {
	readonly activeTargets: number
	readonly lastReconcileAt: number | null
	readonly pendingResults: number
}

export interface ScrapeSchedulerApi {
	/**
	 * Run the scraper forever: reconcile the target list on an interval,
	 * keep one scrape-loop fiber per target, flush scrape results back to the
	 * API periodically. Only exits on interruption.
	 */
	readonly run: Effect.Effect<never, ApiRequestError>
	readonly stats: Effect.Effect<SchedulerStats>
}

const RESULTS_FLUSH_INTERVAL = Duration.seconds(10)
/** Cap the result buffer so an unreachable API cannot grow memory unboundedly. */
const MAX_BUFFERED_RESULTS = 10_000
/**
 * Max results per `scrape-results` POST. The buffer can hold up to
 * `MAX_BUFFERED_RESULTS`; sending that as one body overwhelmed the API Worker
 * (CPU/time → edge 503), so a flush sends in chunks and re-buffers the unsent
 * remainder on the first failure.
 */
const RESULTS_FLUSH_CHUNK_SIZE = 1_000
/** Upper bound on rate-limit backoff so a target keeps probing for recovery. */
const MAX_BACKOFF_MS = Duration.toMillis(Duration.minutes(5))
/**
 * Flat suspension for a target whose org is over its billing limit (HTTP 402
 * from our own ingest gateway). Unlike a rate limit, nothing about scraping
 * again makes this clear — it clears when a human fixes the subscription — so
 * the loop parks for a long, constant period instead of climbing the 5-minute
 * exponential ladder. One probe an hour is enough to notice recovery.
 */
export const DELIVERY_BLOCKED_BACKOFF = Duration.minutes(60)
const DELIVERY_BLOCKED_BACKOFF_MS = Duration.toMillis(DELIVERY_BLOCKED_BACKOFF)

/**
 * Why a scrape failed. Every downstream decision — retry policy, the span's
 * `error.type`, the backoff log line — is derived from this one field, so the
 * four cases can never disagree the way parallel booleans did (a 402 delivery
 * rejection used to back off correctly but log itself as "rate-limited").
 *
 * - `rate_limited` — upstream signalled HTTP 429/503; back off before retrying.
 * - `auth_failed` — upstream rejected the credential (HTTP 401/403). Back off
 *   like a rate limit: the failure won't clear until the org's auth is fixed,
 *   so retrying every interval just hammers the target (prod hit this with
 *   PlanetScale rejecting OAuth bearers on metrics.psdb.cloud every 60s).
 * - `delivery_blocked` — Maple's own ingest gateway refused the metrics for
 *   billing reasons (HTTP 402). Distinct from `auth_failed`, which is about the
 *   *target's* credential. Scraping the target again cannot help: the data has
 *   nowhere to go until the org's subscription is fixed, so back off instead of
 *   paying for a scrape whose result is discarded (prod hit this at full
 *   cadence, ~7.2k failures in 6h across the fleet).
 * - `scrape_failed` — anything else; hold the configured cadence.
 */
export const ScrapeFailureReason = Schema.Literals([
	"rate_limited",
	"auth_failed",
	"delivery_blocked",
	"scrape_failed",
])
export type ScrapeFailureReason = typeof ScrapeFailureReason.Type

export interface ScrapeSucceeded {
	readonly _tag: "Success"
	readonly samplesScraped: number
	readonly samplesPostMetricRelabeling: number
}

export interface ScrapeFailed {
	readonly _tag: "Failure"
	readonly reason: ScrapeFailureReason
	/** Human-readable failure text; reported to the API and used as span status. */
	readonly message: string
	/** Upstream `Retry-After` translated to ms, when present. */
	readonly retryAfterMs?: number
	/** HTTP status behind the failure, when one was seen (402, 429, 503, …). */
	readonly statusCode?: number
}

/** The single value a resolved scrape produces. */
export type ScrapeOutcome = ScrapeSucceeded | ScrapeFailed

export const scrapeSucceeded = (fields: {
	readonly samplesScraped: number
	readonly samplesPostMetricRelabeling: number
}): ScrapeOutcome => ({ _tag: "Success", ...fields })

export const scrapeFailed = (fields: {
	readonly reason: ScrapeFailureReason
	readonly message: string
	readonly retryAfterMs?: number | null
	readonly statusCode?: number | null
}): ScrapeOutcome => ({
	_tag: "Failure",
	reason: fields.reason,
	message: fields.message,
	...(fields.retryAfterMs != null ? { retryAfterMs: fields.retryAfterMs } : undefined),
	...(fields.statusCode != null ? { statusCode: fields.statusCode } : undefined),
})

/**
 * Carries a resolved {@link ScrapeFailed} out of the span so the span closes as
 * an error. The SDK derives a span's `status.message` from the failure's
 * `Error.message` (`Cause.prettyErrors`), so without `message` every failed
 * scrape produced an Error span with a blank description and the reason lived
 * only in the log line emitted after the span had already closed.
 */
class ScrapeAttemptFailed extends Schema.TaggedError<ScrapeAttemptFailed>()(
	"@maple/scraper/ScrapeAttemptFailed",
	{
		message: Schema.String,
		reason: ScrapeFailureReason,
		retryAfterMs: Schema.NullOr(Schema.Number),
	},
) {
	get outcome(): ScrapeOutcome {
		return scrapeFailed({
			reason: this.reason,
			message: this.message,
			retryAfterMs: this.retryAfterMs,
		})
	}
}

/** The failure text to report to the API, or `null` for a healthy scrape. */
export const outcomeError = (outcome: ScrapeOutcome): string | null =>
	outcome._tag === "Failure" ? outcome.message : null

/** A scrape outcome that must escalate the delay instead of holding cadence. */
export const shouldBackOff = (outcome: ScrapeOutcome): boolean =>
	outcome._tag === "Failure" && outcome.reason !== "scrape_failed"

/** The log line for a backing-off scrape — one per reason, exhaustively. */
export const backoffLogMessage = (reason: ScrapeFailureReason): string => {
	switch (reason) {
		case "rate_limited":
			return "Scrape rate-limited, backing off"
		case "auth_failed":
			return "Scrape auth rejected, backing off"
		case "delivery_blocked":
			return "Scrape delivery blocked by the ingest gateway, backing off"
		case "scrape_failed":
			return "Scrape failed, backing off"
	}
}

/**
 * The target period before a target's next scrape. The happy path returns the
 * configured interval; the caller ({@link ScrapeScheduler}'s target loop)
 * subtracts the scrape's own elapsed time so the happy-path cadence stays
 * start-to-start. A rate-limited or auth-rejected scrape escalates
 * exponentially — honoring `Retry-After` when it is longer — capped at
 * {@link MAX_BACKOFF_MS} so the target keeps probing for recovery (an auth fix
 * needs no restart: the credential is resolved server-side per scrape); a
 * delivery-blocked one parks flat for {@link DELIVERY_BLOCKED_BACKOFF}. Either
 * delay runs from scrape end.
 */
export const nextScrapeDelayMs = ({
	baseMs,
	outcome,
	consecutiveBackoffs,
}: {
	readonly baseMs: number
	readonly outcome: ScrapeOutcome
	readonly consecutiveBackoffs: number
}): number => {
	if (!shouldBackOff(outcome)) return baseMs
	// A billing block does not decay: park the target for a flat hour rather
	// than climbing to the 5-minute ceiling and probing 12x as often for a
	// condition only a subscription change can clear.
	if (outcome._tag === "Failure" && outcome.reason === "delivery_blocked") {
		return Math.max(DELIVERY_BLOCKED_BACKOFF_MS, outcome.retryAfterMs ?? 0)
	}
	// exponential is always >= baseMs (consecutiveBackoffs >= 0), so baseMs
	// never needs to be a floor here.
	const exponential = baseMs * 2 ** consecutiveBackoffs
	const retryAfter = (outcome._tag === "Failure" ? outcome.retryAfterMs : undefined) ?? 0
	return Math.min(MAX_BACKOFF_MS, Math.max(exponential, retryAfter))
}

/**
 * Deterministic per-target start delay in `[0, baseMs)`. Discovered sub-targets
 * (PlanetScale branches) share one id and the same interval, so without this
 * they all scrape on the same tick — a synchronized burst that trips
 * PlanetScale's per-org rate limit (429). Derived from a stable key (FNV-1a) so
 * it survives reconciles and needs no random source (keeps tests deterministic).
 */
export const initialJitterMs = (key: string, baseMs: number): number => {
	if (baseMs <= 0) return 0
	let hash = 0x811c9dc5
	for (let i = 0; i < key.length; i++) {
		hash ^= key.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0) % baseMs
}

const hostFromUrl = (url: string): string => {
	try {
		return new URL(url).host
	} catch {
		return url
	}
}

/**
 * Fiber-map key: discovered sub-targets (PlanetScale branches) share one
 * target id, so each `(id, subTargetKey)` pair runs its own scrape loop.
 */
const targetKey = (target: InternalScrapeTarget): string => `${target.id}:${target.subTargetKey ?? ""}`

/** Restart a target's loop when anything affecting its scrape output changes. */
const targetFingerprint = (target: InternalScrapeTarget): string =>
	JSON.stringify([
		target.url,
		target.subTargetKey,
		target.scrapeIntervalSeconds,
		target.name,
		target.serviceName,
		target.orgId,
		target.ingestKey,
		Object.entries(target.labels).sort(([a], [b]) => (a < b ? -1 : 1)),
	])

interface TargetEntry {
	readonly fingerprint: string
	readonly fiber: Fiber.Fiber<unknown, unknown>
}

/**
 * Send `results` to `send` in chunks of `chunkSize`, stopping at the first
 * failed chunk. Returns the results that were NOT delivered (the failed chunk
 * plus everything after it) so the caller can re-buffer just those; `unsent` is
 * empty when the whole batch went through. Chunking keeps any single POST small
 * enough that the API Worker doesn't choke on it.
 */
export const sendResultsInChunks = <E>(
	results: ReadonlyArray<ScrapeResultReport>,
	chunkSize: number,
	send: (chunk: ReadonlyArray<ScrapeResultReport>) => Effect.Effect<void, E>,
): Effect.Effect<{ readonly unsent: ReadonlyArray<ScrapeResultReport>; readonly error: E | null }> =>
	Effect.gen(function* () {
		for (let index = 0; index < results.length; index += chunkSize) {
			const chunk = results.slice(index, index + chunkSize)
			const outcome = yield* Effect.result(send(chunk))
			if (Result.isFailure(outcome)) return { unsent: results.slice(index), error: outcome.failure }
		}
		return { unsent: [], error: null }
	})

/**
 * The pending scrape-result buffer. Contents, capacity, ordering and the
 * `scraper.buffered_results` gauge used to be four independent statements
 * (`enqueue` never touched the gauge at all; a flush zeroed it, sent over the
 * network, then set it to the unsent count — losing anything enqueued in the
 * meantime, and losing the whole batch outright if the flush was interrupted
 * after the drain). Every transition below is atomic under one mutex, and the
 * gauge is written from the same critical section that changed the contents, so
 * the reported size is always the size that is actually buffered.
 *
 * Network I/O must stay OUTSIDE the lock: `take` drains and returns, the caller
 * sends, then `requeue` puts back whatever did not make it.
 */
export interface ResultBuffer {
	/** Append one result, dropping the oldest when at capacity. */
	readonly enqueue: (result: ScrapeResultReport) => Effect.Effect<void>
	/** Atomically drain everything buffered (gauge → 0). */
	readonly take: Effect.Effect<ReadonlyArray<ScrapeResultReport>>
	/** Put undelivered results back in front, keeping the newest at capacity. */
	readonly requeue: (results: ReadonlyArray<ScrapeResultReport>) => Effect.Effect<void>
	readonly size: Effect.Effect<number>
}

export const makeResultBuffer = (capacity: number): Effect.Effect<ResultBuffer> =>
	Effect.gen(function* () {
		const ref = yield* Ref.make<ReadonlyArray<ScrapeResultReport>>([])
		const mutex = yield* Semaphore.make(1)

		// Every transition: mutate contents and publish the resulting size in one
		// critical section, so no interleaving can leave the gauge disagreeing
		// with the buffer.
		const transition = (
			update: (buffered: ReadonlyArray<ScrapeResultReport>) => ReadonlyArray<ScrapeResultReport>,
		) =>
			mutex.withPermits(1)(
				Effect.gen(function* () {
					const next = update(yield* Ref.get(ref))
					yield* Ref.set(ref, next)
					yield* Metric.update(bufferedResults, next.length)
				}),
			)

		return {
			enqueue: (result) => transition((buffered) => [...buffered, result].slice(-capacity)),
			take: mutex.withPermits(1)(
				Effect.gen(function* () {
					const drained = yield* Ref.getAndSet(ref, [])
					yield* Metric.update(bufferedResults, 0)
					return drained
				}),
			),
			requeue: (results) =>
				results.length === 0
					? Effect.void
					: transition((buffered) => [...results, ...buffered].slice(-capacity)),
			size: Effect.map(Ref.get(ref), (buffered) => buffered.length),
		} satisfies ResultBuffer
	})

export class ScrapeScheduler extends Context.Service<ScrapeScheduler, ScrapeSchedulerApi>()(
	"@maple/scraper/ScrapeScheduler",
	{
		make: Effect.gen(function* () {
			const env = yield* ScraperEnv
			const api = yield* ApiClient
			const otlp = yield* OtlpIngest

			const semaphore = yield* Semaphore.make(env.SCRAPER_CONCURRENCY)
			const results = yield* makeResultBuffer(MAX_BUFFERED_RESULTS)
			const fibersRef = yield* Ref.make(new Map<string, TargetEntry>())
			const lastReconcileRef = yield* Ref.make<number | null>(null)

			const recordOutcome = (
				target: InternalScrapeTarget,
				scrapedAt: number,
				durationMs: number,
				outcome: ScrapeOutcome,
			) =>
				results.enqueue(
					new ScrapeResultReport({
						targetId: target.id,
						scrapedAt,
						error: outcomeError(outcome),
						subTargetKey: target.subTargetKey,
						durationMs,
						...(outcome._tag === "Success"
							? {
									samplesScraped: outcome.samplesScraped,
									samplesPostMetricRelabeling: outcome.samplesPostMetricRelabeling,
								}
							: undefined),
					}),
				)

			const scrapeOnce = (target: InternalScrapeTarget) =>
				semaphore.withPermits(1)(
					Effect.gen(function* () {
						const scrapeTimeMs = yield* Clock.currentTimeMillis

						const outcome: ScrapeOutcome = yield* Effect.gen(function* () {
							const attempt = yield* Effect.gen(function* () {
								const response = yield* api.scrapeTarget(target.id, target.subTargetKey)
								if (response.status < 200 || response.status >= 300) {
									return scrapeFailed({
										message: `target returned HTTP ${response.status}`,
										reason:
											response.status === 429 || response.status === 503
												? "rate_limited"
												: response.status === 401 || response.status === 403
													? "auth_failed"
													: "scrape_failed",
										retryAfterMs:
											response.retryAfterSeconds !== null
												? response.retryAfterSeconds * 1000
												: null,
									})
								}

								const parsed = parsePrometheusText(response.body)
								const converted = convertFamiliesToOtlp(parsed.families, {
									targetId: target.id,
									targetName: target.name,
									serviceName: target.serviceName ?? target.name,
									instance: hostFromUrl(target.url),
									targetLabels: target.labels,
									scrapeTimeMs,
								})

								if (converted.request !== null) {
									yield* otlp.send(target.ingestKey, converted.request)
								}

								yield* Effect.annotateCurrentSpan({
									"maple.scraper.sum_data_points": converted.dataPointCounts.sum,
									"maple.scraper.gauge_data_points": converted.dataPointCounts.gauge,
									"maple.scraper.histogram_data_points":
										converted.dataPointCounts.histogram,
									"maple.scraper.dropped_series": converted.droppedSeriesCount,
									"maple.scraper.skipped_lines": parsed.skippedLineCount,
								})
								return scrapeSucceeded({
									samplesScraped: parsed.families.reduce(
										(total, family) => total + family.samples.length,
										0,
									),
									samplesPostMetricRelabeling:
										converted.dataPointCounts.sum +
										converted.dataPointCounts.gauge +
										converted.dataPointCounts.histogram,
								})
							}).pipe(
								Effect.catch((error) => {
									const gatewayStatus =
										error._tag === "@maple/scraper/OtlpIngestError" ? error.status : null
									return Effect.succeed(
										scrapeFailed({
											message: error.message,
											// The gateway's 402 is the one failure in here that a
											// retry provably cannot clear.
											reason:
												gatewayStatus === 402 ? "delivery_blocked" : "scrape_failed",
											statusCode: gatewayStatus,
										}),
									)
								}),
								Effect.catchDefect((defect) =>
									Effect.succeed(
										scrapeFailed({
											message: Cause.pretty(Cause.die(defect)),
											reason: "scrape_failed",
										}),
									),
								),
							)

							if (attempt._tag === "Failure") {
								// `error.type` buckets the failure so the reason is groupable
								// without parsing the free-text message — the same field the
								// retry policy and the backoff log line read.
								yield* Effect.annotateCurrentSpan("error.type", attempt.reason)
								if (attempt.statusCode != null) {
									yield* Effect.annotateCurrentSpan(
										"http.response.status_code",
										attempt.statusCode,
									)
								}
								// A billing block is an expected, caller-side condition (our own
								// gateway answering 402), not a fault of this scrape: per the
								// repo's OTEL posture only 5xx is `Error`. Returning the outcome
								// instead of failing leaves the span `Ok` with the reason on its
								// attributes, so a blocked org stops minting an Error span (and a
								// new error fingerprint) every single interval, forever. The Warn
								// log below still reports it.
								if (attempt.reason === "delivery_blocked") {
									yield* Effect.annotateCurrentSpan(
										"maple.scrape.outcome",
										"delivery_blocked",
									)
									return attempt
								}
								return yield* new ScrapeAttemptFailed({
									message: attempt.message,
									reason: attempt.reason,
									retryAfterMs: attempt.retryAfterMs ?? null,
								})
							}
							return attempt
						}).pipe(
							Effect.withSpan("scraper.scrape_target", {
								// Each scrape is its own trace. Target loops are forked from
								// inside `reconcile`, so the forked fiber inherits the
								// `scraper.reconcile` span as its ambient parent and keeps it
								// for the fiber's whole (unbounded) lifetime. Without `root`
								// every scrape — across every target of that reconcile, for
								// hours — became a child of that one span and propagated its
								// traceparent to the API, collapsing thousands of independent
								// scrapes into a single trace (prod: 10.8k `Server` spans on
								// /api/internal/prometheus-scrape under one TraceId over 9h).
								root: true,
								attributes: {
									orgId: target.orgId,
									"maple.scraper.target_id": target.id,
									"maple.scraper.target_name": target.name,
									"maple.scraper.interval_seconds": target.scrapeIntervalSeconds,
									...(target.subTargetKey
										? {
												"maple.scraper.sub_target_key": target.subTargetKey,
											}
										: undefined),
								},
							}),
							Effect.catchTag("@maple/scraper/ScrapeAttemptFailed", (failure) =>
								Effect.succeed(failure.outcome),
							),
						)

						const durationMs = (yield* Clock.currentTimeMillis) - scrapeTimeMs
						yield* Metric.update(scrapeDurationMs, durationMs)
						yield* Metric.update(scrapesTotal, outcome._tag === "Success" ? "ok" : "error")
						yield* recordOutcome(target, scrapeTimeMs, durationMs, outcome)
						if (outcome._tag === "Failure") {
							yield* Effect.logWarning("Scrape failed").pipe(
								Effect.annotateLogs({
									targetId: target.id,
									orgId: target.orgId,
									reason: outcome.reason,
									error: outcome.message,
								}),
							)
						}
						return outcome
					}),
				)

			// Scrape, then sleep before the next pass. The happy path holds the
			// configured interval; a 429/503 (rate limit) or 401/403 (rejected
			// credential) escalates the delay (see nextScrapeDelayMs) so the target
			// backs off and self-recovers instead of hammering the upstream every
			// interval.
			const targetLoop = (target: InternalScrapeTarget) => {
				const baseMs = target.scrapeIntervalSeconds * 1000
				const loop = (consecutiveBackoffs: number): Effect.Effect<never> =>
					Effect.gen(function* () {
						const startedAt = yield* Clock.currentTimeMillis
						const outcome = yield* scrapeOnce(target)
						const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt
						const backingOff = shouldBackOff(outcome)
						const delayMs = nextScrapeDelayMs({ baseMs, outcome, consecutiveBackoffs })
						if (backingOff && outcome._tag === "Failure") {
							yield* Effect.logWarning(backoffLogMessage(outcome.reason)).pipe(
								Effect.annotateLogs({
									targetId: target.id,
									orgId: target.orgId,
									...(target.subTargetKey
										? { subTargetKey: target.subTargetKey }
										: undefined),
									reason: outcome.reason,
									delayMs,
									retryAfterMs: outcome.retryAfterMs ?? null,
									consecutiveBackoffs: consecutiveBackoffs + 1,
								}),
							)
						}
						// Happy path: subtract the scrape's own elapsed time so cadence
						// stays start-to-start (matching the old Schedule.fixed). Backoff
						// runs the full delay from scrape end so Retry-After is honored.
						const sleepMs = backingOff ? delayMs : Math.max(0, delayMs - elapsedMs)
						yield* Effect.sleep(Duration.millis(sleepMs))
						return yield* loop(backingOff ? consecutiveBackoffs + 1 : 0)
					})
				// Plain targets have nothing to de-sync against; only stagger the
				// branches of a discovered (PlanetScale) target so they spread across
				// the interval instead of bursting together.
				if (target.subTargetKey == null) return loop(0)
				const jitterMs = initialJitterMs(targetKey(target), baseMs)
				return Effect.flatMap(Effect.sleep(Duration.millis(jitterMs)), () => loop(0))
			}

			const reconcile = Effect.gen(function* () {
				const targets = yield* api.listTargets()
				const current = yield* Ref.get(fibersRef)
				const next = new Map<string, TargetEntry>()

				// Collapse the list to one target per `targetKey` (last wins). The
				// fork decision below reads `existing` from the *previous* map, so
				// two rows sharing a key would each fork a loop fiber while only the
				// last is tracked in `next` — the rest leak, uninterrupted, every
				// reconcile. (Prod hit this: PlanetScale discovery returned many rows
				// that all collapsed to subTargetKey "metrics.psdb.cloud".) The API
				// also dedupes now; this keeps the scheduler correct regardless.
				const deduped = new Map<string, InternalScrapeTarget>()
				for (const target of targets) deduped.set(targetKey(target), target)
				const duplicateTargetsDropped = targets.length - deduped.size

				yield* Effect.forEach(
					deduped.values(),
					(target) =>
						Effect.gen(function* () {
							const key = targetKey(target)
							const fingerprint = targetFingerprint(target)
							const existing = current.get(key)
							if (existing && existing.fingerprint === fingerprint) {
								next.set(key, existing)
								return
							}
							if (existing) yield* Fiber.interrupt(existing.fiber)
							const fiber = yield* Effect.forkChild(targetLoop(target))
							next.set(key, { fingerprint, fiber })
						}),
					{ discard: true },
				)

				yield* Effect.forEach(
					current,
					([id, entry]) => (next.has(id) ? Effect.void : Fiber.interrupt(entry.fiber)),
					{ discard: true },
				)

				yield* Ref.set(fibersRef, next)
				yield* Ref.set(lastReconcileRef, yield* Clock.currentTimeMillis)
				yield* Metric.update(activeTargets, next.size)
				yield* Effect.annotateCurrentSpan({
					"maple.scraper.active_targets": next.size,
					"maple.scraper.duplicate_targets_dropped": duplicateTargetsDropped,
				})
				if (duplicateTargetsDropped > 0) {
					yield* Effect.logWarning("Dropped duplicate scrape targets sharing one key").pipe(
						Effect.annotateLogs({ duplicateTargetsDropped, distinctTargets: next.size }),
					)
				}
			}).pipe(
				Effect.withSpan("scraper.reconcile"),
				// A failed list fetch keeps the current fibers running untouched.
				Effect.catch((error) =>
					Effect.logWarning("Failed to refresh scrape target list").pipe(
						Effect.annotateLogs({ error: error.message }),
					),
				),
			)

			const flushResults = Effect.gen(function* () {
				const batch = yield* results.take
				if (batch.length === 0) return
				// `pending` shrinks as chunks land, so an interrupt mid-flush re-buffers
				// exactly what was never delivered instead of dropping the whole batch
				// (the drain already emptied the buffer).
				const pending = yield* Ref.make(batch)
				// Send in chunks so one POST never overwhelms the API Worker; re-buffer
				// only what didn't make it (in front) and retry on the next flush.
				const { error } = yield* sendResultsInChunks(batch, RESULTS_FLUSH_CHUNK_SIZE, (chunk) =>
					api
						.reportResults(chunk)
						.pipe(Effect.tap(() => Ref.update(pending, (rest) => rest.slice(chunk.length)))),
				).pipe(Effect.onInterrupt(() => Effect.flatMap(Ref.get(pending), results.requeue)))
				const unsent = yield* Ref.get(pending)
				if (unsent.length > 0) {
					yield* results.requeue(unsent)
					yield* Effect.logWarning("Failed to report scrape results").pipe(
						Effect.annotateLogs({
							error: error?.message ?? "unknown",
							bufferedResults: unsent.length,
						}),
					)
				}
			}).pipe(Effect.withSpan("scraper.flush_results"))

			const run = Effect.gen(function* () {
				yield* Effect.forkChild(
					flushResults.pipe(Effect.repeat(Schedule.spaced(RESULTS_FLUSH_INTERVAL))),
				)
				return yield* reconcile.pipe(
					Effect.repeat(Schedule.spaced(Duration.seconds(env.SCRAPER_RECONCILE_INTERVAL_SECONDS))),
					Effect.flatMap(() => Effect.never),
				)
			}) as Effect.Effect<never, ApiRequestError>

			const stats = Effect.gen(function* () {
				const fibers = yield* Ref.get(fibersRef)
				const lastReconcileAt = yield* Ref.get(lastReconcileRef)
				const pendingResults = yield* results.size
				return {
					activeTargets: fibers.size,
					lastReconcileAt,
					pendingResults,
				} satisfies SchedulerStats
			})

			return { run, stats } satisfies ScrapeSchedulerApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
