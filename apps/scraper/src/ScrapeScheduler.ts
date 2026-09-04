import {
	Cause,
	Clock,
	Context,
	Duration,
	Effect,
	FiberMap,
	Layer,
	Metric,
	Queue,
	Ref,
	Result,
	Schedule,
	Schema,
	Semaphore,
} from "effect"
import { ScrapeResultReport, ScrapeTargetId, type InternalScrapeTarget } from "@maple/domain/http"
import { ApiClient } from "./ApiClient"
import { TargetFetcher } from "./TargetFetcher"
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
	readonly run: Effect.Effect<never>
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
 * - `target_error` — the target answered with a server error (5xx other than
 *   503). A target stuck on HTTP 500 held full cadence forever, minting an
 *   Error span (and an alert-feeding error event) every interval; back off
 *   like a rate limit so a broken target is probed, not hammered.
 * - `scrape_failed` — anything else; hold the configured cadence.
 */
export const ScrapeFailureReason = Schema.Literals([
	"rate_limited",
	"auth_failed",
	"delivery_blocked",
	"target_error",
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
		statusCode: Schema.NullOr(Schema.Number),
		// Target identity travels on the failure itself, not just the span
		// attributes: the error event/issue built from this failure is what a
		// triage sees first, and "target returned HTTP 500" with no identity
		// forced a trace-attribute hunt that came up empty.
		targetId: ScrapeTargetId,
		targetName: Schema.String,
		targetHost: Schema.String,
	},
) {
	get outcome(): ScrapeOutcome {
		return scrapeFailed({
			reason: this.reason,
			message: this.message,
			retryAfterMs: this.retryAfterMs,
			statusCode: this.statusCode,
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
		case "target_error":
			return "Scrape target returning server errors, backing off"
		case "scrape_failed":
			return "Scrape failed, backing off"
	}
}

/**
 * The target period before a target's next scrape. The happy path returns the
 * configured interval; the caller ({@link ScrapeScheduler}'s target loop)
 * subtracts the scrape's own elapsed time so the happy-path cadence stays
 * start-to-start. A rate-limited, auth-rejected, or server-erroring scrape escalates
 * exponentially — honoring `Retry-After` when it is longer — capped at
 * {@link MAX_BACKOFF_MS} so the target keeps probing for recovery (an auth fix
 * needs no restart: each scrape reads the credential the latest target list
 * carries); a
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

/**
 * FiberMap key for a target's scrape loop. The fingerprint is part of the key
 * on purpose: "this target's config changed" and "this target was removed"
 * both reduce to "a running key is no longer desired", so one interrupt path
 * in {@link reconcile} covers both, and the FiberMap owns the fiber lifecycle
 * (interrupt-on-replace, removal on completion) that a hand-rolled
 * `Ref<Map<string, Fiber>>` had to re-implement.
 */
const loopKey = (target: InternalScrapeTarget): string => `${targetKey(target)}|${targetFingerprint(target)}`

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

export class ScrapeScheduler extends Context.Service<ScrapeScheduler, ScrapeSchedulerApi>()(
	"@maple/scraper/ScrapeScheduler",
	{
		make: Effect.gen(function* () {
			const env = yield* ScraperEnv
			const api = yield* ApiClient
			const otlp = yield* OtlpIngest
			const fetcher = yield* TargetFetcher

			const semaphore = yield* Semaphore.make(env.SCRAPER_CONCURRENCY)
			// Sliding: at capacity the oldest buffered result is dropped for the
			// newest, so an unreachable API cannot grow memory unboundedly.
			const results = yield* Queue.sliding<ScrapeResultReport>(MAX_BUFFERED_RESULTS)
			const lastReconcileRef = yield* Ref.make<number | null>(null)
			// Loop count as of the last reconcile, for {@link stats}: the FiberMap
			// itself lives inside `run`'s scope (see below), not the service.
			const activeLoopsRef = yield* Ref.make(0)
			// The newest copy of every desired target, keyed by {@link targetKey}. A
			// loop is forked with a snapshot and only restarted when its
			// {@link loopKey} changes, but `scrapeUrl` (PlanetScale's signed
			// `?sig=&exp=` params rotate every discovery refresh) and `authHeaders`
			// (a rotated credential) are deliberately outside that key: each scrape
			// reads them from here instead, so a rotation neither restarts the loop
			// nor leaves it fetching with an expired signature until the loop dies.
			const latestTargets = yield* Ref.make(new Map<string, InternalScrapeTarget>())

			// The gauge is republished after every queue transition rather than
			// mutated inside one; the queue is the single source of truth for size.
			const publishBufferGauge = Effect.suspend(() =>
				Metric.update(bufferedResults, Queue.sizeUnsafe(results)),
			)

			const recordOutcome = (
				target: InternalScrapeTarget,
				scrapedAt: number,
				durationMs: number,
				outcome: ScrapeOutcome,
			) =>
				Queue.offer(
					results,
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
				).pipe(Effect.flatMap(() => publishBufferGauge))

			const scrapeOnce = (target: InternalScrapeTarget) =>
				semaphore.withPermits(1)(
					Effect.gen(function* () {
						const scrapeTimeMs = yield* Clock.currentTimeMillis
						const targetHost = hostFromUrl(target.url)

						// Every failure path fails with a ScrapeAttemptFailed carrying the
						// target's identity, built where the failure is understood.
						const attemptFailed = (fields: {
							readonly message: string
							readonly reason: ScrapeFailureReason
							readonly retryAfterMs?: number | null
							readonly statusCode?: number | null
						}) =>
							new ScrapeAttemptFailed({
								message: fields.message,
								reason: fields.reason,
								retryAfterMs: fields.retryAfterMs ?? null,
								statusCode: fields.statusCode ?? null,
								targetId: target.id,
								targetName: target.name,
								targetHost,
							})

						const attempt: Effect.Effect<ScrapeOutcome, ScrapeAttemptFailed> = Effect.gen(
							function* () {
								const latest = yield* Ref.get(latestTargets)
								const response = yield* fetcher.fetch(latest.get(targetKey(target)) ?? target)
								if (response.status < 200 || response.status >= 300) {
									return yield* attemptFailed({
										// Identity in the message so the error issue and its
										// fingerprint name the target instead of pooling every
										// broken target under one anonymous "HTTP 500".
										message: `target "${target.name}" (${targetHost}) returned HTTP ${response.status}`,
										reason:
											response.status === 429 || response.status === 503
												? "rate_limited"
												: response.status === 401 || response.status === 403
													? "auth_failed"
													: response.status >= 500
														? "target_error"
														: "scrape_failed",
										retryAfterMs:
											response.retryAfterSeconds !== null
												? response.retryAfterSeconds * 1000
												: null,
										statusCode: response.status,
									})
								}

								const parsed = parsePrometheusText(response.body)
								const converted = convertFamiliesToOtlp(parsed.families, {
									targetId: target.id,
									targetName: target.name,
									serviceName: target.serviceName ?? target.name,
									instance: targetHost,
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
							},
						).pipe(
							Effect.catchTags({
								"@maple/scraper/TargetFetchError": (error) =>
									attemptFailed({
										message: `target "${target.name}" (${targetHost}) ${error.message}`,
										// An unreachable or stalled target backs off like an upstream
										// 5xx; a URL that fails SSRF validation is a config fault no
										// cadence clears, so it just keeps reporting at interval.
										reason:
											error.reason === "invalid_url" ? "scrape_failed" : "target_error",
									}),
								"@maple/scraper/OtlpIngestError": (error) =>
									attemptFailed({
										message: error.message,
										// The gateway's 402 is the one failure in here that a
										// retry provably cannot clear.
										reason: error.status === 402 ? "delivery_blocked" : "scrape_failed",
										statusCode: error.status,
									}),
							}),
							Effect.catchDefect((defect) =>
								attemptFailed({
									message: Cause.pretty(Cause.die(defect)),
									reason: "scrape_failed",
								}),
							),
						)

						const outcome: ScrapeOutcome = yield* attempt.pipe(
							// `error.type` buckets the failure so the reason is groupable
							// without parsing the free-text message — the same field the
							// retry policy and the backoff log line read.
							Effect.tapError((failure) =>
								Effect.annotateCurrentSpan({
									"error.type": failure.reason,
									...(failure.statusCode != null
										? { "http.response.status_code": failure.statusCode }
										: undefined),
								}),
							),
							// A billing block is an expected, caller-side condition (our own
							// gateway answering 402), not a fault of this scrape: per the
							// repo's OTEL posture only 5xx is `Error`. Recovering inside the
							// span leaves it `Ok` with the reason on its attributes, so a
							// blocked org stops minting an Error span (and a new error
							// fingerprint) every single interval, forever. The Warn log below
							// still reports it.
							Effect.catchIf(
								(failure) => failure.reason === "delivery_blocked",
								(failure) =>
									Effect.annotateCurrentSpan(
										"maple.scrape.outcome",
										"delivery_blocked",
									).pipe(Effect.as(failure.outcome)),
							),
							Effect.withSpan("scraper.scrape_target", {
								// Each scrape is its own trace. Target loops are forked from
								// inside `reconcile`, so the forked fiber inherits the
								// `scraper.reconcile` span as its ambient parent and keeps it
								// for the fiber's whole (unbounded) lifetime. Without `root`
								// every scrape — across every target of that reconcile, for
								// hours — became a child of that one span and propagated its
								// traceparent to the API, collapsing thousands of independent
								// scrapes into a single trace (prod: 10.8k `Server` spans on the
								// API-side scrape proxy of the time under one TraceId over 9h).
								root: true,
								attributes: {
									orgId: target.orgId,
									"maple.scraper.target_id": target.id,
									"maple.scraper.target_name": target.name,
									"maple.scraper.target_host": targetHost,
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
									targetName: target.name,
									targetHost,
									orgId: target.orgId,
									...(target.subTargetKey
										? { subTargetKey: target.subTargetKey }
										: undefined),
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

			const reconcile = (loops: FiberMap.FiberMap<string>) =>
				Effect.gen(function* () {
					const targets = yield* api.listTargets()

					// Collapse the list to one target per `targetKey` (last wins): two
					// rows sharing a key must not each run a loop fiber. (Prod hit this:
					// PlanetScale discovery returned many rows that all collapsed to
					// subTargetKey "metrics.psdb.cloud".) The API also dedupes now; this
					// keeps the scheduler correct regardless.
					const deduped = new Map<string, InternalScrapeTarget>()
					for (const target of targets) deduped.set(targetKey(target), target)
					const duplicateTargetsDropped = targets.length - deduped.size
					yield* Ref.set(latestTargets, deduped)

					const desired = new Map<string, InternalScrapeTarget>()
					for (const target of deduped.values()) desired.set(loopKey(target), target)

					// Interrupt stale loops (target removed, or config changed — either
					// way its {@link loopKey} is no longer desired) BEFORE forking
					// replacements, so an old and a new loop for the same target never
					// scrape concurrently.
					yield* Effect.forEach(
						Array.from(loops, ([key]) => key),
						(key) => (desired.has(key) ? Effect.void : FiberMap.remove(loops, key)),
						{ discard: true },
					)
					// An unchanged target's running loop is left untouched. The fork is a
					// plain child fork (not FiberMap.run's detached one) so the loop
					// inherits the run fiber's scheduler and clock; the map only does the
					// bookkeeping — interrupt on removal, drop entries on completion.
					yield* Effect.forEach(
						desired,
						([key, target]) =>
							Effect.flatMap(FiberMap.has(loops, key), (running) =>
								running
									? Effect.void
									: Effect.flatMap(Effect.forkChild(targetLoop(target)), (fiber) =>
											FiberMap.set(loops, key, fiber),
										),
							),
						{ discard: true },
					)

					yield* Ref.set(lastReconcileRef, yield* Clock.currentTimeMillis)
					const running = yield* FiberMap.size(loops)
					yield* Ref.set(activeLoopsRef, running)
					yield* Metric.update(activeTargets, running)
					yield* Effect.annotateCurrentSpan({
						"maple.scraper.active_targets": running,
						"maple.scraper.duplicate_targets_dropped": duplicateTargetsDropped,
					})
					if (duplicateTargetsDropped > 0) {
						yield* Effect.logWarning("Dropped duplicate scrape targets sharing one key").pipe(
							Effect.annotateLogs({ duplicateTargetsDropped, distinctTargets: desired.size }),
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
				const batch = yield* Queue.clear(results)
				yield* publishBufferGauge
				if (batch.length === 0) return
				// `pending` shrinks as chunks land; the `ensuring` below re-buffers
				// exactly what was never delivered — whether the flush failed or was
				// interrupted mid-flight (the drain already emptied the queue, so
				// dropping `pending` would lose the batch outright).
				const pending = yield* Ref.make<ReadonlyArray<ScrapeResultReport>>(batch)
				const requeuePending = Effect.gen(function* () {
					const rest = yield* Ref.get(pending)
					if (rest.length === 0) return
					yield* Queue.offerAll(results, rest)
					yield* publishBufferGauge
				})
				// Send in chunks so one POST never overwhelms the API Worker; the
				// remainder retries on the next flush.
				const { error, unsent } = yield* sendResultsInChunks(
					batch,
					RESULTS_FLUSH_CHUNK_SIZE,
					(chunk) =>
						api
							.reportResults(chunk)
							.pipe(Effect.tap(() => Ref.update(pending, (rest) => rest.slice(chunk.length)))),
				).pipe(Effect.ensuring(requeuePending))
				if (unsent.length > 0) {
					yield* Effect.logWarning("Failed to report scrape results").pipe(
						Effect.annotateLogs({
							error: error?.message ?? "unknown",
							bufferedResults: unsent.length,
						}),
					)
				}
			}).pipe(Effect.withSpan("scraper.flush_results"))

			// The FiberMap is created inside `run`'s own scope, so the scrape loops
			// live and die with the run fiber — interrupting `run` stops scraping —
			// rather than with the layer that built this service.
			const run = Effect.scoped(
				Effect.gen(function* () {
					const loops = yield* FiberMap.make<string>()
					yield* Effect.forkChild(
						flushResults.pipe(Effect.repeat(Schedule.spaced(RESULTS_FLUSH_INTERVAL))),
					)
					yield* reconcile(loops).pipe(
						Effect.repeat(
							Schedule.spaced(Duration.seconds(env.SCRAPER_RECONCILE_INTERVAL_SECONDS)),
						),
					)
					return yield* Effect.never
				}),
			)

			const stats = Effect.gen(function* () {
				const activeLoops = yield* Ref.get(activeLoopsRef)
				const lastReconcileAt = yield* Ref.get(lastReconcileRef)
				const pendingResults = yield* Queue.size(results)
				return {
					activeTargets: activeLoops,
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
