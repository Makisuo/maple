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

export interface ScrapeSchedulerShape {
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

export interface ScrapeOutcome {
	readonly error: string | null
	readonly samplesScraped?: number
	readonly samplesPostMetricRelabeling?: number
	/** Upstream signalled a rate limit (HTTP 429/503) — back off before retrying. */
	readonly rateLimited: boolean
	/**
	 * Upstream rejected the credential (HTTP 401/403) — back off like a rate
	 * limit: the failure won't clear until the org's auth is fixed, so retrying
	 * every interval just hammers the target (prod hit this with PlanetScale
	 * rejecting OAuth bearers on metrics.psdb.cloud every 60s).
	 */
	readonly authFailed: boolean
	/**
	 * Maple's own ingest gateway refused the metrics for billing reasons (HTTP
	 * 402) — distinct from `authFailed`, which is about the *target's*
	 * credential. Scraping the target again cannot help: the data has nowhere to
	 * go until the org's subscription is fixed, so back off instead of paying for
	 * a scrape whose result is discarded (prod hit this at full cadence, ~7.2k
	 * failures in 6h across the fleet).
	 */
	readonly deliveryBlocked: boolean
	/** Upstream `Retry-After` translated to ms, when present. */
	readonly retryAfterMs: number | null
}

class ScrapeAttemptFailed extends Schema.TaggedErrorClass<ScrapeAttemptFailed>()("ScrapeAttemptFailed", {
	outcome: Schema.Struct({
		error: Schema.NullOr(Schema.String),
		samplesScraped: Schema.optional(Schema.Number),
		samplesPostMetricRelabeling: Schema.optional(Schema.Number),
		rateLimited: Schema.Boolean,
		authFailed: Schema.Boolean,
		deliveryBlocked: Schema.Boolean,
		retryAfterMs: Schema.NullOr(Schema.Number),
	}),
}) {}

/** A scrape outcome that must escalate the delay instead of holding cadence. */
export const shouldBackOff = (outcome: ScrapeOutcome): boolean =>
	outcome.rateLimited || outcome.authFailed || outcome.deliveryBlocked

/**
 * The target period before a target's next scrape. The happy path returns the
 * configured interval; the caller ({@link ScrapeScheduler}'s target loop)
 * subtracts the scrape's own elapsed time so the happy-path cadence stays
 * start-to-start. A rate-limited or auth-rejected scrape escalates
 * exponentially — honoring `Retry-After` when it is longer — capped at
 * {@link MAX_BACKOFF_MS} so the target keeps probing for recovery (an auth fix
 * needs no restart: the credential is resolved server-side per scrape); that
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
	// exponential is always >= baseMs (consecutiveBackoffs >= 0), so baseMs
	// never needs to be a floor here.
	const exponential = baseMs * 2 ** consecutiveBackoffs
	const retryAfter = outcome.retryAfterMs ?? 0
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

export class ScrapeScheduler extends Context.Service<ScrapeScheduler, ScrapeSchedulerShape>()(
	"@maple/scraper/ScrapeScheduler",
	{
		make: Effect.gen(function* () {
			const env = yield* ScraperEnv
			const api = yield* ApiClient
			const otlp = yield* OtlpIngest

			const semaphore = yield* Semaphore.make(env.SCRAPER_CONCURRENCY)
			const resultsRef = yield* Ref.make<ReadonlyArray<ScrapeResultReport>>([])
			const fibersRef = yield* Ref.make(new Map<string, TargetEntry>())
			const lastReconcileRef = yield* Ref.make<number | null>(null)

			const enqueueResult = (result: ScrapeResultReport) =>
				Ref.update(resultsRef, (buffered) =>
					buffered.length >= MAX_BUFFERED_RESULTS
						? [...buffered.slice(1), result]
						: [...buffered, result],
				)

			const recordOutcome = (
				target: InternalScrapeTarget,
				scrapedAt: number,
				durationMs: number,
				outcome: ScrapeOutcome,
			) =>
				enqueueResult(
					new ScrapeResultReport({
						targetId: target.id,
						scrapedAt,
						error: outcome.error,
						subTargetKey: target.subTargetKey,
						durationMs,
						...(outcome.samplesScraped !== undefined
							? { samplesScraped: outcome.samplesScraped }
							: {}),
						...(outcome.samplesPostMetricRelabeling !== undefined
							? { samplesPostMetricRelabeling: outcome.samplesPostMetricRelabeling }
							: {}),
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
									return {
										error: `target returned HTTP ${response.status}`,
										rateLimited: response.status === 429 || response.status === 503,
										authFailed: response.status === 401 || response.status === 403,
										deliveryBlocked: false,
										retryAfterMs:
											response.retryAfterSeconds !== null
												? response.retryAfterSeconds * 1000
												: null,
									} satisfies ScrapeOutcome
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
								return {
									error: null,
									samplesScraped: parsed.families.reduce(
										(total, family) => total + family.samples.length,
										0,
									),
									samplesPostMetricRelabeling:
										converted.dataPointCounts.sum +
										converted.dataPointCounts.gauge +
										converted.dataPointCounts.histogram,
									rateLimited: false,
									authFailed: false,
									deliveryBlocked: false,
									retryAfterMs: null,
								} satisfies ScrapeOutcome
							}).pipe(
								Effect.catch((error) =>
									Effect.succeed<ScrapeOutcome>({
										error: error.message,
										rateLimited: false,
										authFailed: false,
										// The gateway's 402 is the one failure in here that a
										// retry provably cannot clear.
										deliveryBlocked:
											error._tag === "@maple/scraper/OtlpIngestError" &&
											error.status === 402,
										retryAfterMs: null,
									}),
								),
								Effect.catchDefect((defect) =>
									Effect.succeed<ScrapeOutcome>({
										error: Cause.pretty(Cause.die(defect)),
										rateLimited: false,
										authFailed: false,
										deliveryBlocked: false,
										retryAfterMs: null,
									}),
								),
							)

							if (attempt.error !== null) {
								return yield* new ScrapeAttemptFailed({ outcome: attempt })
							}
							return attempt
						}).pipe(
							Effect.withSpan("scraper.scrape_target", {
								attributes: {
									orgId: target.orgId,
									"maple.scraper.target_id": target.id,
									"maple.scraper.target_name": target.name,
									"maple.scraper.interval_seconds": target.scrapeIntervalSeconds,
									...(target.subTargetKey
										? { "maple.scraper.sub_target_key": target.subTargetKey }
										: {}),
								},
							}),
							Effect.catchTag("ScrapeAttemptFailed", ({ outcome }) => Effect.succeed(outcome)),
						)

						const durationMs = (yield* Clock.currentTimeMillis) - scrapeTimeMs
						yield* Metric.update(scrapeDurationMs, durationMs)
						yield* Metric.update(scrapesTotal, outcome.error === null ? "ok" : "error")
						yield* recordOutcome(target, scrapeTimeMs, durationMs, outcome)
						if (outcome.error !== null) {
							yield* Effect.logWarning("Scrape failed").pipe(
								Effect.annotateLogs({
									targetId: target.id,
									orgId: target.orgId,
									error: outcome.error,
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
						if (backingOff) {
							yield* Effect.logWarning(
								outcome.authFailed
									? "Scrape auth rejected, backing off"
									: "Scrape rate-limited, backing off",
							).pipe(
								Effect.annotateLogs({
									targetId: target.id,
									orgId: target.orgId,
									...(target.subTargetKey ? { subTargetKey: target.subTargetKey } : {}),
									delayMs,
									retryAfterMs: outcome.retryAfterMs,
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
				const results = yield* Ref.getAndSet(resultsRef, [])
				yield* Metric.update(bufferedResults, 0)
				if (results.length === 0) return
				// Send in chunks so one POST never overwhelms the API Worker; re-buffer
				// only what didn't make it (in front) and retry on the next flush.
				const { unsent, error } = yield* sendResultsInChunks(
					results,
					RESULTS_FLUSH_CHUNK_SIZE,
					api.reportResults,
				)
				if (unsent.length > 0) {
					yield* Ref.update(resultsRef, (buffered) =>
						[...unsent, ...buffered].slice(-MAX_BUFFERED_RESULTS),
					)
					yield* Effect.logWarning("Failed to report scrape results").pipe(
						Effect.annotateLogs({
							error: error?.message ?? "unknown",
							bufferedResults: unsent.length,
						}),
					)
					yield* Metric.update(bufferedResults, unsent.length)
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
				const pending = yield* Ref.get(resultsRef)
				return {
					activeTargets: fibers.size,
					lastReconcileAt,
					pendingResults: pending.length,
				} satisfies SchedulerStats
			})

			return { run, stats } satisfies ScrapeSchedulerShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
