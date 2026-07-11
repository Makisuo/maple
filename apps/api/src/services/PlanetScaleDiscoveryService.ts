import {
	OrgId,
	ScrapeTargetEncryptionError,
	ScrapeTargetPersistenceError,
	type ScrapeTargetAuthError,
} from "@maple/domain/http"
import type { scrapeTargets } from "@maple/db"
import { Clock, Context, Duration, Effect, Layer, Redacted, Ref, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { parseBase64Aes256GcmKey } from "../lib/Crypto"
import { Env } from "../lib/Env"
import { buildScrapeAuthHeaders, catchOAuthTokenFailure } from "../lib/scrape-auth"
import { validateExternalUrlSync } from "../lib/url-validator"
import { decodeDiscoveryConfig } from "./planetscale/discovery-config"
import { PlanetScaleOAuthService, planetScaleBearerHeader } from "./PlanetScaleOAuthService"

type ScrapeTargetRow = typeof scrapeTargets.$inferSelect

/**
 * Resolves PlanetScale `planetscale`-type scrape targets into their concrete
 * per-database-branch scrape endpoints via PlanetScale's Prometheus http_sd
 * discovery API (`GET /v1/organizations/{org}/metrics`). Managed targets
 * (`authType "planetscale_oauth"`) authenticate with the org's OAuth grant
 * (`Authorization: Bearer …`); manual escape-hatch targets keep the service
 * token scheme (`Authorization: token {ID}:{SECRET}`).
 *
 * Discovery results are cached in-memory per target with a 10-minute TTL
 * (PlanetScale's documented refresh cadence). On refresh failure stale entries
 * keep being served so transient control-plane blips don't drop every branch
 * scrape; the error is remembered and surfaced by the caller.
 */

export interface PlanetScaleSubTarget {
	/** Concrete per-branch scrape URL (`https://{host}{__metrics_path__}`). */
	readonly url: string
	/** Stable discriminator: `planetscale_database_branch_id` SD label, falling back to `host:port`. */
	readonly subTargetKey: string
	/** SD labels minus `__`-prefixed Prometheus meta labels. */
	readonly labels: Record<string, string>
}

const HttpSdResponse = Schema.Array(
	Schema.Struct({
		targets: Schema.Array(Schema.String),
		labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	}),
)

const DISCOVERY_TTL_MS = Duration.toMillis(Duration.minutes(10))
const DISCOVERY_TIMEOUT = Duration.seconds(10)

export const planetScaleDiscoveryUrl = (organization: string): string =>
	`https://api.planetscale.com/v1/organizations/${encodeURIComponent(organization)}/metrics`

interface CacheEntry {
	readonly fetchedAt: number
	readonly entries: ReadonlyArray<PlanetScaleSubTarget>
	readonly lastError: string | null
}

const toPersistenceError = (message: string) => new ScrapeTargetPersistenceError({ message })

/** Convert one http_sd group into sub-targets, dropping SSRF-invalid hosts. */
const subTargetsFromGroup = (group: {
	readonly targets: ReadonlyArray<string>
	readonly labels?: Record<string, string> | undefined
}): { readonly ok: Array<PlanetScaleSubTarget>; readonly dropped: Array<string> } => {
	const sdLabels = group.labels ?? {}
	const scheme = sdLabels.__scheme__ ?? "https"
	const path = sdLabels.__metrics_path__ ?? "/metrics"
	const labels: Record<string, string> = {}
	for (const [key, value] of Object.entries(sdLabels)) {
		if (!key.startsWith("__")) labels[key] = value
	}
	const branchId = sdLabels.planetscale_database_branch_id

	const ok: Array<PlanetScaleSubTarget> = []
	const dropped: Array<string> = []
	for (const hostPort of group.targets) {
		const url = `${scheme}://${hostPort}${path}`
		try {
			validateExternalUrlSync(url)
		} catch {
			dropped.push(url)
			continue
		}
		const subTargetKey =
			branchId && group.targets.length === 1
				? branchId
				: branchId
					? `${branchId}:${hostPort}`
					: hostPort
		ok.push({ url, subTargetKey, labels })
	}
	return { ok, dropped }
}

/**
 * Collapse sub-targets sharing a `subTargetKey` (last wins). The scraper keys
 * one scrape-loop fiber per `(targetId, subTargetKey)`, so duplicate keys would
 * each fork a fiber that the scheduler can't track — a runaway scrape loop.
 * Two entries with the same key resolve to the same logical endpoint, so
 * collapsing them is lossless. Happens when an http_sd payload exposes several
 * groups that fall back to the same host key (no `planetscale_database_branch_id`).
 */
const dedupeBySubTargetKey = (
	entries: ReadonlyArray<PlanetScaleSubTarget>,
): ReadonlyArray<PlanetScaleSubTarget> => {
	const byKey = new Map<string, PlanetScaleSubTarget>()
	for (const entry of entries) byKey.set(entry.subTargetKey, entry)
	return [...byKey.values()]
}

/**
 * Branch name a filter pattern matches against: PlanetScale's http_sd exposes
 * the human branch name as `planetscale_branch`; older payloads only carry
 * `planetscale_database_branch_id`. Fall back to the sub-target key so a filter
 * never silently matches nothing.
 */
const branchNameForFilter = (entry: PlanetScaleSubTarget): string =>
	entry.labels.planetscale_branch ?? entry.labels.planetscale_database_branch_id ?? entry.subTargetKey

/** Glob → anchored RegExp supporting `*` (any run) and `?` (one char). */
const globToRegExp = (pattern: string): RegExp => {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".")
	return new RegExp(`^${escaped}$`)
}

interface BranchFilters {
	readonly include: ReadonlyArray<string>
	readonly exclude: ReadonlyArray<string>
}

/** Read include/exclude branch globs off the row's `discovery_config_json`. */
const parseBranchFilters = (discoveryConfigJson: unknown): BranchFilters => {
	const cfg = decodeDiscoveryConfig(discoveryConfigJson)
	return { include: cfg?.includeBranches ?? [], exclude: cfg?.excludeBranches ?? [] }
}

/** exclude wins over include; an empty include list means "all branches". */
const branchPassesFilters = (name: string, filters: BranchFilters): boolean => {
	if (filters.exclude.some((pattern) => globToRegExp(pattern).test(name))) return false
	if (filters.include.length > 0 && !filters.include.some((pattern) => globToRegExp(pattern).test(name)))
		return false
	return true
}

export interface PlanetScaleDiscoveryServiceShape {
	/**
	 * Resolve a planetscale target row into its discovered sub-targets,
	 * refreshing the cache when older than the TTL. Fails only when discovery
	 * fails AND no stale cache exists.
	 */
	readonly discover: (
		row: ScrapeTargetRow,
	) => Effect.Effect<
		ReadonlyArray<PlanetScaleSubTarget>,
		ScrapeTargetPersistenceError | ScrapeTargetEncryptionError | ScrapeTargetAuthError
	>
	/** Last discovery error for a target (null when the last refresh succeeded). */
	readonly lastError: (targetId: string) => Effect.Effect<string | null>
	/** Drop a target's cached discovery (after credential/org changes or delete). */
	readonly invalidate: (targetId: string) => Effect.Effect<void>
}

export class PlanetScaleDiscoveryService extends Context.Service<
	PlanetScaleDiscoveryService,
	PlanetScaleDiscoveryServiceShape
>()("@maple/api/services/PlanetScaleDiscoveryService", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const psOAuth = yield* PlanetScaleOAuthService
		const httpClient = yield* HttpClient.HttpClient
		const encryptionKey = yield* parseBase64Aes256GcmKey(
			Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			(message) => new ScrapeTargetEncryptionError({ message }),
		)

		const cache = yield* Ref.make(new Map<string, CacheEntry>())

		// Managed rows store no credentials — resolve (and auto-refresh) the org's
		// OAuth grant at discovery time; manual rows decrypt their stored token.
		const authHeadersForRow = Effect.fn("PlanetScaleDiscoveryService.authHeadersForRow")(function* (
			row: ScrapeTargetRow,
		) {
			if (row.authType !== "planetscale_oauth") {
				return yield* buildScrapeAuthHeaders(row, encryptionKey)
			}
			const { accessToken } = yield* psOAuth
				.getValidAccessToken(Schema.decodeUnknownSync(OrgId)(row.orgId))
				.pipe(Effect.catchTags(catchOAuthTokenFailure))
			return { Authorization: planetScaleBearerHeader(accessToken) }
		})

		const fetchSubTargets = Effect.fn("PlanetScaleDiscoveryService.fetchSubTargets")(function* (
			row: ScrapeTargetRow,
		) {
			const headers = yield* authHeadersForRow(row)
			const response = yield* Effect.gen(function* () {
				const request = HttpClientRequest.get(row.url).pipe(HttpClientRequest.setHeaders(headers))
				const res = yield* httpClient.execute(request)
				const text = yield* res.text
				return { status: res.status, text }
			}).pipe(
				Effect.mapError((error) =>
					toPersistenceError(`PlanetScale discovery request failed: ${error.message}`),
				),
				Effect.timeoutOrElse({
					duration: DISCOVERY_TIMEOUT,
					orElse: () =>
						Effect.fail(toPersistenceError("PlanetScale discovery request timed out after 10s")),
				}),
			)

			if (response.status < 200 || response.status >= 300) {
				return yield* Effect.fail(
					toPersistenceError(
						response.status === 401 || response.status === 403
							? row.authType === "planetscale_oauth"
								? `PlanetScale discovery rejected the OAuth token (HTTP ${response.status}). Check the OAuth app's read_metrics_endpoints scope and reconnect.`
								: `PlanetScale discovery rejected the service token (HTTP ${response.status}). Check the token id/secret and its read_metrics_endpoints permission.`
							: `PlanetScale discovery failed: HTTP ${response.status}`,
					),
				)
			}

			const groups = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(HttpSdResponse))(
				response.text,
			).pipe(
				Effect.mapError(() =>
					toPersistenceError("PlanetScale discovery returned an unexpected payload"),
				),
			)

			const collected: Array<PlanetScaleSubTarget> = []
			const dropped: Array<string> = []
			for (const group of groups) {
				const converted = subTargetsFromGroup(group)
				collected.push(...converted.ok)
				dropped.push(...converted.dropped)
			}
			if (dropped.length > 0) {
				yield* Effect.logWarning(
					"Dropped PlanetScale discovered targets failing URL validation",
				).pipe(Effect.annotateLogs({ scrapeTargetId: row.id, dropped: dropped.join(", ") }))
			}

			// Guarantee one entry per subTargetKey so the scraper never forks more
			// than one loop fiber per key (a runaway scrape loop otherwise).
			const entries = dedupeBySubTargetKey(collected)
			if (entries.length < collected.length) {
				yield* Effect.logWarning("Collapsed duplicate PlanetScale sub-targets sharing a key").pipe(
					Effect.annotateLogs({
						scrapeTargetId: row.id,
						collapsed: collected.length - entries.length,
						distinct: entries.length,
					}),
				)
			}

			// Apply the org's branch include/exclude globs so PR-preview branches
			// (et al.) aren't scraped — the main lever against PlanetScale 429s from
			// fanning out across every branch in the org.
			const filters = parseBranchFilters(row.discoveryConfigJson)
			if (filters.include.length === 0 && filters.exclude.length === 0) {
				return entries
			}
			const kept = entries.filter((entry) =>
				branchPassesFilters(branchNameForFilter(entry), filters),
			)
			if (kept.length < entries.length) {
				yield* Effect.logInfo("Filtered PlanetScale branches by include/exclude globs").pipe(
					Effect.annotateLogs({
						scrapeTargetId: row.id,
						kept: kept.length,
						filtered: entries.length - kept.length,
					}),
				)
			}
			return kept
		})

		const discover = Effect.fn("PlanetScaleDiscoveryService.discover")(function* (row: ScrapeTargetRow) {
			const now = yield* Clock.currentTimeMillis
			const cached = (yield* Ref.get(cache)).get(row.id)
			if (cached && now - cached.fetchedAt < DISCOVERY_TTL_MS) {
				return cached.entries
			}

			const fresh = yield* fetchSubTargets(row).pipe(
				Effect.map((entries) => ({ ok: true as const, entries })),
				Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
			)
			if (fresh.ok) {
				yield* Ref.update(cache, (map) =>
					new Map(map).set(row.id, { fetchedAt: now, entries: fresh.entries, lastError: null }),
				)
				return fresh.entries
			}

			const message = fresh.error.message

			if (cached) {
				// Serve stale entries through transient discovery failures; keep the
				// stale fetchedAt so the next call retries instead of waiting a TTL.
				yield* Effect.logWarning("PlanetScale discovery failed; serving stale targets").pipe(
					Effect.annotateLogs({ scrapeTargetId: row.id, error: message }),
				)
				yield* Ref.update(cache, (map) => new Map(map).set(row.id, { ...cached, lastError: message }))
				return cached.entries
			}

			return yield* Effect.fail(fresh.error)
		})

		const lastError = (targetId: string) =>
			Ref.get(cache).pipe(Effect.map((map) => map.get(targetId)?.lastError ?? null))

		const invalidate = (targetId: string) =>
			Ref.update(cache, (map) => {
				const next = new Map(map)
				next.delete(targetId)
				return next
			})

		return { discover, lastError, invalidate } satisfies PlanetScaleDiscoveryServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
