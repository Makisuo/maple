import type {
	ErrorRateByServiceRequest,
	ErrorsByTypeRequest,
	ErrorsSummaryRequest,
	ErrorsTimeseriesRequest,
	ServiceOverviewRequest,
} from "@maple/domain/http"
import * as CH from "../ch"
import { makeDirectRouteCachePolicy } from "../runtime/query-engine"
import { defineQuery } from "./query-def"

/**
 * The declarative warehouse query registry.
 *
 * Each entry replaces the profile/context/error-label/cache wiring that used to
 * be repeated inline in every handler in `apps/api/src/routes/v1/query-engine.http.ts`.
 * Handlers keep their own row-to-response mapping; see `QueryDef` for why
 * decoding is deliberately out of scope here.
 *
 * Migration is incremental and the two surfaces coexist: a handler either takes
 * a `QueryDef` through `runQuery` or keeps its inline wiring. Nothing breaks
 * while entries are added.
 *
 * Cache values below are carried over EXACTLY as the handlers had them, so this
 * pilot changes no caching behaviour — `cache: undefined` here means the handler
 * was uncached before, not that being uncached is correct. Turning any of those
 * on is a separate, separately-reviewed change with a justified TTL.
 */

export const errorsByType = defineQuery({
	id: "errorsByType",
	profile: "aggregation",
	// Was uncached inline. Preserved as-is: changing it belongs in its own commit.
	cache: undefined,
	compile: (payload: ErrorsByTypeRequest, orgId: string) =>
		CH.compile(
			CH.errorsByTypeQuery({
				rootOnly: payload.rootOnly,
				services: payload.services,
				deploymentEnvs: payload.deploymentEnvs,
				fingerprintHashes: payload.fingerprintHashes,
				limit: payload.limit,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const errorsTimeseries = defineQuery({
	id: "errorsTimeseries",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: ErrorsTimeseriesRequest, orgId: string) =>
		CH.compile(
			CH.errorsTimeseriesQuery({
				fingerprintHash: payload.fingerprintHash,
				services: payload.services,
			}),
			{
				orgId,
				startTime: payload.startTime,
				endTime: payload.endTime,
				// Matches the handler's previous inline default. The builder needs a
				// bucket width and the request treats it as optional.
				bucketSeconds: payload.bucketSeconds ?? 3600,
			},
		),
})

/** Single-row: the handler reads this through `runQueryFirst`. */
export const errorsSummary = defineQuery({
	id: "errorsSummary",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: ErrorsSummaryRequest, orgId: string) =>
		CH.compile(
			CH.errorsSummaryQuery({
				rootOnly: payload.rootOnly,
				services: payload.services,
				deploymentEnvs: payload.deploymentEnvs,
				fingerprintHashes: payload.fingerprintHashes,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const errorRateByService = defineQuery({
	id: "errorRateByService",
	profile: "aggregation",
	cache: undefined,
	// The builder takes no options — this query is scoped entirely by org and
	// time range. The payload still carries the range.
	compile: (payload: ErrorRateByServiceRequest, orgId: string) =>
		CH.compile(CH.errorRateByServiceQuery(), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

export const serviceOverview = defineQuery({
	id: "serviceOverview",
	profile: "aggregation",
	// v2: rows gained per-commit `firstSeen`; the version bump keeps pre-upgrade
	// cached rows (missing the field) from being served. Carried over verbatim
	// from the handler — do not renumber without the same reasoning.
	cache: makeDirectRouteCachePolicy({ ttlSeconds: 15, version: 2 }),
	compile: (payload: ServiceOverviewRequest, orgId: string) =>
		CH.compile(
			CH.serviceOverviewQuery({
				environments: payload.environments,
				namespaces: payload.namespaces,
				commitShas: payload.commitShas,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})
