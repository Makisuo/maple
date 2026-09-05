// Typed Releases Queries
//
// A release, for these queries, is a commit the moment it starts serving
// traffic: the service-overview rollups pre-extract `vcs.ref.head.revision` as
// `CommitSha` and key on it, so every row here is a GROUP BY over the same
// splice the services list already reads. Nothing scans the raw traces table.

import { Schema } from "effect"
import * as T from "@maple-dev/clickhouse-builder/types"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param, from, type CHQuery, type CompiledQueryRowSchema } from "@maple-dev/clickhouse-builder"
import type { ColumnDefs } from "@maple-dev/clickhouse-builder/types"
import { ErrorEventsByTime, ServiceOverviewSpans } from "../tables"
import { CHNumber } from "../schema"
import { serviceOverviewWhereConditions } from "./query-helpers"
import { serviceOverviewWindows, serviceWindowTiersForBucket } from "./services"

/**
 * At most this many (service, environment, commit) rows per request. A fleet
 * that deploys every push accumulates thousands of shas in a month; the page
 * lists the newest and says how many it left out.
 */
export const RELEASES_LIST_CAP = 500

export interface ReleasesListOpts {
	readonly serviceName?: string
	readonly serviceNames?: readonly string[]
	readonly environments?: readonly string[]
	readonly namespaces?: readonly string[]
	readonly excludedEnvironments?: readonly string[]
	readonly excludedNamespaces?: readonly string[]
	readonly limit?: number
}

export interface ReleasesListOutput {
	readonly serviceName: string
	readonly environment: string
	readonly commitSha: string
	readonly firstSeen: string
	readonly spanCount: number
	readonly errorCount: number
	readonly p50LatencyMs: number
	readonly p95LatencyMs: number
	readonly p99LatencyMs: number
	readonly apdexSatisfiedCount: number
	readonly apdexToleratingCount: number
}

export const releasesListRowSchema = Schema.Struct({
	serviceName: Schema.String,
	environment: Schema.String,
	commitSha: Schema.String,
	firstSeen: Schema.String,
	// `CHNumber`, never `Schema.Number`: UInt64 counts arrive quoted on a
	// gateway that refuses `output_format_json_quote_64bit_integers=0`.
	spanCount: CHNumber,
	errorCount: CHNumber,
	p50LatencyMs: CHNumber,
	p95LatencyMs: CHNumber,
	p99LatencyMs: CHNumber,
	apdexSatisfiedCount: CHNumber,
	apdexToleratingCount: CHNumber,
}) satisfies CompiledQueryRowSchema<ReleasesListOutput>

/**
 * One row per (service, environment, commit) in the window, newest first.
 *
 * Every version of a service is a row, not just the latest — a release's
 * impact is "this version against every other version of the same service in
 * the same minutes", and the caller derives that split from these rows. The
 * same query scoped to one service is therefore also the detail page's
 * comparison table.
 */
export function releasesListQuery(opts: ReleasesListOpts = {}) {
	return serviceOverviewWindows({
		serviceName: opts.serviceName,
		environments: opts.environments,
		namespaces: opts.namespaces,
		excludedEnvironments: opts.excludedEnvironments,
		excludedNamespaces: opts.excludedNamespaces,
	})
		.select(($) => ({
			serviceName: $.bServiceName,
			environment: $.bEnvironment,
			commitSha: $.bCommitSha,
			firstSeen: CH.min_($.bFirstSeen),
			spanCount: CH.sum($.bSpanCount),
			errorCount: CH.sum($.bErrorCount),
			p50LatencyMs: CH.rawExpr(
				"arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000",
				T.float64,
			),
			p95LatencyMs: CH.rawExpr(
				"arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000",
				T.float64,
			),
			p99LatencyMs: CH.rawExpr(
				"arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000",
				T.float64,
			),
			apdexSatisfiedCount: CH.sum($.bApdexSatisfiedCount),
			apdexToleratingCount: CH.sum($.bApdexToleratingCount),
		}))
		.where(($) => [
			$.bCommitSha.neq(""),
			opts.serviceNames?.length ? CH.inList($.bServiceName, opts.serviceNames) : undefined,
		])
		.groupBy("serviceName", "environment", "commitSha")
		.orderBy(["firstSeen", "desc"], ["spanCount", "desc"])
		.limit(opts.limit ?? RELEASES_LIST_CAP)
		.format("JSON")
}

// Releases timeline
//
// The org-wide sibling of `serviceReleasesTimelineQuery`: per bucket, per
// service, per commit. Feeds the swimlanes and the per-service rollout share
// (which version carried the last bucket's traffic).

export interface ReleasesTimelineOpts {
	readonly serviceName?: string
	readonly serviceNames?: readonly string[]
	readonly environments?: readonly string[]
	readonly namespaces?: readonly string[]
	readonly excludedEnvironments?: readonly string[]
	readonly excludedNamespaces?: readonly string[]
	/**
	 * Needed at build time, not just as a compile parameter: it selects which
	 * rollup tiers can answer, because a tier coarser than the bucket has no
	 * position inside it.
	 */
	readonly bucketSeconds: number
}

export interface ReleasesTimelineOutput {
	readonly bucket: string
	readonly serviceName: string
	readonly commitSha: string
	readonly count: number
}

const RELEASES_TIMELINE_CAP = 5000

/** Sub-minute buckets: no rollup tier can place a row inside a minute. */
function releasesTimelineRawQuery(
	opts: ReleasesTimelineOpts,
): CHQuery<ColumnDefs, ReleasesTimelineOutput, {}> {
	return from(ServiceOverviewSpans)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
			serviceName: $.ServiceName,
			commitSha: $.CommitSha,
			count: CH.count(),
		}))
		.where(($) => [
			...serviceOverviewWhereConditions($, {
				serviceName: opts.serviceName,
				serviceNames: opts.serviceNames,
				environments: opts.environments,
				namespaces: opts.namespaces,
				excludedEnvironments: opts.excludedEnvironments,
				excludedNamespaces: opts.excludedNamespaces,
			}),
			$.CommitSha.neq(""),
		])
		.groupBy("bucket", "serviceName", "commitSha")
		.orderBy(["bucket", "asc"])
		.limit(RELEASES_TIMELINE_CAP)
		.format("JSON") as CHQuery<ColumnDefs, ReleasesTimelineOutput, {}>
}

export function releasesTimelineQuery(
	opts: ReleasesTimelineOpts,
): CHQuery<ColumnDefs, ReleasesTimelineOutput, {}> {
	const tiers = serviceWindowTiersForBucket(opts.bucketSeconds)
	if (tiers === "raw") return releasesTimelineRawQuery(opts)

	return serviceOverviewWindows(
		{
			serviceName: opts.serviceName,
			environments: opts.environments,
			namespaces: opts.namespaces,
			excludedEnvironments: opts.excludedEnvironments,
			excludedNamespaces: opts.excludedNamespaces,
		},
		tiers,
	)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.bBucket, param.int("bucketSeconds")),
			serviceName: $.bServiceName,
			commitSha: $.bCommitSha,
			count: CH.sum($.bSpanCount),
		}))
		.where(($) => [
			$.bCommitSha.neq(""),
			opts.serviceNames?.length ? CH.inList($.bServiceName, opts.serviceNames) : undefined,
		])
		.groupBy("bucket", "serviceName", "commitSha")
		.orderBy(["bucket", "asc"])
		.limit(RELEASES_TIMELINE_CAP)
		.format("JSON") as CHQuery<ColumnDefs, ReleasesTimelineOutput, {}>
}

// Error fingerprints on a version
//
// The bridge from a release to the issues system. Traces key a release on
// `vcs.ref.head.revision`; error events key on `service.version`, which Maple's
// SDKs stamp with the same sha. Reads the per-occurrence projection because a
// release starts at an arbitrary instant and a minute rollup would smear the
// first occurrences across the deploy boundary.

export interface ReleaseErrorFingerprintsOpts {
	readonly serviceName: string
	readonly environments?: readonly string[]
	readonly limit?: number
}

export interface ReleaseErrorFingerprintsOutput {
	readonly fingerprintHash: string
	readonly count: number
	readonly firstSeen: string
}

export const releaseErrorFingerprintsRowSchema = Schema.Struct({
	// `toString()`-wrapped in the SELECT: a UInt64 hash above 2^53 corrupts as
	// a JS number.
	fingerprintHash: Schema.String,
	count: CHNumber,
	firstSeen: Schema.String,
}) satisfies CompiledQueryRowSchema<ReleaseErrorFingerprintsOutput>

export function releaseErrorFingerprintsQuery(opts: ReleaseErrorFingerprintsOpts) {
	return from(ErrorEventsByTime)
		.select(($) => ({
			fingerprintHash: CH.toString_($.FingerprintHash),
			count: CH.count(),
			firstSeen: CH.min_($.Timestamp),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(opts.serviceName),
			$.ServiceVersion.eq(param.string("serviceVersion")),
			$.Timestamp.gte(param.dateTimeSeconds("startTime")),
			$.Timestamp.lte(param.dateTimeSeconds("endTime")),
			opts.environments?.length ? CH.inList($.DeploymentEnv, opts.environments) : undefined,
		])
		.groupBy("fingerprintHash")
		.orderBy(["count", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}
