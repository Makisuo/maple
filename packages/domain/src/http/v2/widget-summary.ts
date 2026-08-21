import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { ErrorPersistenceError, IssueSeverity } from "../errors"
import { OrgId, ServiceName } from "../../primitives"
import { AuthorizationV2 } from "./auth"
import { wireExample, Timestamp } from "./envelopes"
import { publicError } from "./public-error"
import { V2QueryErrors } from "./query-errors"
import { ErrorIssuePublicId } from "./resource-ids"

/**
 * The iOS Home Screen widgets' one read.
 *
 * A separate resource family rather than a shaped view over `/v2/error_issues`
 * + `/v2/services` + `/v2/traces/timeseries`, for two reasons that are not
 * "three requests is more than one":
 *
 * 1. **It is the credential's fence.** `requiredScopeForRequest` derives an API
 *    key's required scope from the first path segment, so a key scoped
 *    `widget_summary:read` can reach exactly this endpoint and nothing else.
 *    Composed from the generic endpoints, the same widget would need
 *    `error_issues:read` + `services:read` + `traces:read` — an organization
 *    read key, sitting on a phone. For the same reason this must never be
 *    nested under another family's prefix.
 * 2. **A widget extension has no budget to compose.** It is woken by WidgetKit
 *    with seconds of wall clock and tens of megabytes, and it deliberately does
 *    not link the generated client. One request it can decode by hand is the
 *    only shape that fits.
 *
 * The windows are the server's, not the caller's: "ongoing issues" and "traffic
 * right now" are product definitions the widgets render, and a query parameter
 * would let two builds of the app disagree about what the Home Screen means.
 */

/** Ongoing means the app's "Needs attention" filter over the day Home considers recent. */
export const WIDGET_SUMMARY_ISSUES_WINDOW_SECONDS = 60 * 60 * 24
/** Throughput is a "right now" number — Home's rate window, and the Services tab's. */
export const WIDGET_SUMMARY_THROUGHPUT_WINDOW_SECONDS = 60 * 60

/**
 * Enough issues that `open_count` is meaningful and the rows shown are really
 * the worst ones; past this the widget renders a floor ("20+").
 */
export const WIDGET_SUMMARY_ISSUE_LIMIT = 20
/**
 * The widget charts far fewer, but the organization total is summed across
 * every service — so this is deliberately wider than what is drawn.
 */
export const WIDGET_SUMMARY_SERVICE_LIMIT = 50
/** Series returned with per-service buckets. Matches what the widget can draw. */
export const WIDGET_SUMMARY_SERIES_LIMIT = 12

/**
 * The wire's own version, independent of the API version.
 *
 * The reader is an App Store binary that cannot be updated in step with a
 * deploy, so the server needs a way to know which shape a caller understands
 * before it adds a field that changes how one is drawn. Bump only when the
 * meaning of an existing field changes; new optional fields do not need it.
 */
export const WIDGET_SUMMARY_SCHEMA_VERSION = 1

export const V2WidgetSummaryIssue = Schema.Struct({
	id: ErrorIssuePublicId,
	/**
	 * The raw naming fields, not a rendered title. The app's issue list and the
	 * widget must fall back identically — a title that resolves differently in
	 * the two places reads as two different issues — and the one implementation
	 * of that fallback lives on the client, next to the list that also uses it.
	 */
	exception_type: Schema.String,
	error_label: Schema.String,
	exception_message: Schema.String,
	service_name: Schema.String,
	severity: Schema.NullOr(IssueSeverity),
	occurrence_count: Schema.Number,
	last_seen_at: Timestamp,
	/** Fixed, then seen again — the state that means a deploy undid a fix. */
	is_regressed: Schema.Boolean,
	has_open_incident: Schema.Boolean,
}).annotate({
	identifier: "WidgetSummaryIssue",
	title: "Widget summary issue",
	description: "One ongoing error issue, reduced to what a Home Screen row can render.",
})
export type V2WidgetSummaryIssue = Schema.Schema.Type<typeof V2WidgetSummaryIssue>

export const V2WidgetSummaryService = Schema.Struct({
	name: ServiceName,
	throughput_per_second: Schema.Number,
	/** 0–1, not a percentage. */
	error_rate: Schema.Number,
	p95_latency_ms: Schema.Number,
	/**
	 * Span counts per bucket, oldest first — **counts, not rates**. The client
	 * divides by `bucket_seconds` so the sparkline and the headline provably
	 * carry the same unit, and so a bucket length the client cannot make sense
	 * of drops the series rather than drawing counts as if they were rates.
	 */
	points: Schema.Array(Schema.Number),
}).annotate({
	identifier: "WidgetSummaryService",
	title: "Widget summary service",
	description: "One service's traffic over the throughput window.",
})
export type V2WidgetSummaryService = Schema.Schema.Type<typeof V2WidgetSummaryService>

export const V2WidgetSummaryIssues = Schema.Struct({
	window_seconds: Schema.Number,
	/**
	 * More ongoing issues exist than `data` carries, so a count derived from it
	 * is a floor. The widget renders that as "20+" rather than a wrong total.
	 */
	has_more: Schema.Boolean,
	data: Schema.Array(V2WidgetSummaryIssue),
}).annotate({
	identifier: "WidgetSummaryIssues",
	title: "Widget summary issues",
})

export const V2WidgetSummaryThroughput = Schema.Struct({
	window_seconds: Schema.Number,
	/**
	 * Bucket length behind every `points` array. Null when no series could be
	 * read, which tells the client to render the scalars without a sparkline
	 * instead of guessing a unit.
	 */
	bucket_seconds: Schema.NullOr(Schema.Number),
	services: Schema.Array(V2WidgetSummaryService),
	/**
	 * The ungrouped organization series, in the same bucket counts as
	 * `services[].points`.
	 *
	 * Not the sum of `services[].points`: the per-service series is capped at
	 * the charted few, so summing it would under-report a large organization's
	 * shape. The scalar total is still derived client-side from every service
	 * row, which is why only the series appears here.
	 */
	total_points: Schema.Array(Schema.Number),
}).annotate({
	identifier: "WidgetSummaryThroughput",
	title: "Widget summary throughput",
})

export const V2WidgetSummary = Schema.Struct({
	object: Schema.Literal("widget_summary").annotate({
		description: 'The object type — always `"widget_summary"`.',
	}),
	schema_version: Schema.Number.annotate({
		description:
			"The widget wire shape's own version. Clients that do not recognise it should keep rendering their last good snapshot rather than decode against a shape whose fields may have changed meaning.",
	}),
	/** When the server read the data — the age every widget renders from. */
	generated_at: Timestamp,
	/**
	 * Echoed so the caller can prove the payload belongs to the organization it
	 * asked for before writing it over that organization's cached snapshot.
	 * There is deliberately no name here: the client already resolves names from
	 * its own membership index, and a second source would let a widget render
	 * one organization's name over another's numbers.
	 */
	organization_id: OrgId,
	issues: V2WidgetSummaryIssues,
	throughput: V2WidgetSummaryThroughput,
}).annotate({
	identifier: "WidgetSummary",
	title: "Widget summary",
	description:
		"Everything the Maple iOS Home Screen widgets draw, in one response: ongoing error issues over the last day, and per-service traffic over the last hour.",
	examples: [
		wireExample({
			object: "widget_summary",
			schema_version: 1,
			generated_at: "2026-08-21T09:10:00.000Z",
			organization_id: "org_2abcDEF",
			issues: {
				window_seconds: 86_400,
				has_more: false,
				data: [
					{
						id: "iss_YofPTrK9782DWwcnXhpcCw",
						exception_type: "TypeError",
						error_label: "checkout",
						exception_message: "Cannot read properties of undefined",
						service_name: "api",
						severity: "critical",
						occurrence_count: 412,
						last_seen_at: "2026-08-21T09:08:12.000Z",
						is_regressed: false,
						has_open_incident: true,
					},
				],
			},
			throughput: {
				window_seconds: 3600,
				bucket_seconds: 300,
				services: [
					{
						name: "api",
						throughput_per_second: 12.5,
						error_rate: 0.012,
						p95_latency_ms: 184,
						points: [3600, 3720, 3540],
					},
				],
				total_points: [5200, 5310, 5180],
			},
		}),
	],
})
export type V2WidgetSummary = Schema.Schema.Type<typeof V2WidgetSummary>

export class V2WidgetSummaryApiGroup extends HttpApiGroup.make("widgetSummary")
	.add(
		HttpApiEndpoint.get("retrieve", "/", {
			success: V2WidgetSummary,
			error: [publicError(ErrorPersistenceError), ...V2QueryErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getWidgetSummary",
				summary: "Retrieve the mobile widget summary",
				description:
					"Returns ongoing error issues and per-service traffic in a single small payload sized for a Home Screen widget. The windows are fixed by the server. Requires the `widget_summary:read` scope.",
			}),
		),
	)
	.prefix("/v2/widget_summary")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Widget Summary",
			description:
				"The single read behind the Maple mobile Home Screen widgets. Deliberately its own scope family so a device credential can be fenced to it alone.",
		}),
	) {}
