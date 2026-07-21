import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { V2AlertDestinationCreateParams } from "./alert-destinations"
import { V2AlertIncident } from "./alert-incidents"
import { V2AlertRule, V2AlertRuleMutationResponse } from "./alert-rules"
import { V2ApiKey, V2ApiKeyMutationResponse, V2ApiKeyWithSecret } from "./api-keys"
import { V2DashboardMutation } from "./dashboards"
import { V2ErrorIssue, V2ErrorIssueDetail } from "./error-issues"
import { requiredScopeForRequest, scopeAllows, V2Scope } from "./auth"
import {
	decodeOffsetCursor,
	encodeOffsetCursor,
	isoTimestamp,
	ListQuery,
	paginateArray,
	paginateOffsetQuery,
	Timestamp,
} from "./envelopes"
import { notFound, permissionError, rateLimited, V2NotFoundError, V2RateLimitError } from "./errors"
import { encodePublicId } from "./public-id"
import {
	LogPublicId,
	V2AttributeFilter,
	V2MetricsTimeseriesParams,
	V2TraceTimeseriesParams,
} from "./telemetry"

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e"

describe("V2ApiKey wire format", () => {
	it("encodes snake_case fields, an object type, and a key_ public ID", () => {
		const key = Schema.decodeUnknownSync(V2ApiKey)({
			id: encodePublicId("key", UUID),
			object: "api_key",
			name: "ci",
			description: null,
			key_prefix: "maple_ak_abc...",
			kind: "standard",
			scopes: ["dashboards:read"],
			revoked: false,
			revoked_at: null,
			last_used_at: null,
			expires_at: null,
			created_at: "2026-07-15T00:00:00.000Z",
			created_by: "user_123",
			created_by_email: null,
		})
		expect(key.id).toBe(UUID) // decoded to the internal ID

		const wire = Schema.encodeSync(V2ApiKey)(key)
		expect(wire.id).toBe(encodePublicId("key", UUID))
		expect(wire.object).toBe("api_key")
		expect(wire.key_prefix).toBe("maple_ak_abc...")
		expect(wire.created_at).toBe("2026-07-15T00:00:00.000Z")
		expect("keyPrefix" in wire).toBe(false)
	})

	it("keeps txid on mutation responses but out of the base resource", () => {
		const base = {
			id: encodePublicId("key", UUID),
			object: "api_key" as const,
			name: "ci",
			description: null,
			key_prefix: "maple_ak_abc...",
			kind: "standard" as const,
			scopes: null,
			revoked: false,
			revoked_at: null,
			last_used_at: null,
			expires_at: null,
			created_at: "2026-07-15T00:00:00.000Z",
			created_by: "user_123",
			created_by_email: null,
		}
		const withSecret = Schema.decodeUnknownSync(V2ApiKeyWithSecret)({
			...base,
			secret: "maple_ak_secret",
			txid: "81234",
		})
		const revoked = Schema.decodeUnknownSync(V2ApiKeyMutationResponse)({ ...base, txid: "81235" })

		expect(Schema.encodeSync(V2ApiKeyWithSecret)(withSecret).txid).toBe("81234")
		expect(Schema.encodeSync(V2ApiKeyMutationResponse)(revoked).txid).toBe("81235")
		expect("txid" in Schema.encodeSync(V2ApiKey)(Schema.decodeUnknownSync(V2ApiKey)(base))).toBe(false)
	})

	it("rejects non-Postgres transaction IDs", () => {
		expect(() =>
			Schema.decodeUnknownSync(V2ApiKeyMutationResponse)({
				id: encodePublicId("key", UUID),
				object: "api_key",
				name: "ci",
				description: null,
				key_prefix: "maple_ak_abc...",
				kind: "standard",
				scopes: null,
				revoked: true,
				revoked_at: "2026-07-15T00:00:00.000Z",
				last_used_at: null,
				expires_at: null,
				created_at: "2026-07-15T00:00:00.000Z",
				created_by: "user_123",
				created_by_email: null,
				txid: "not-a-txid",
			}),
		).toThrow()
	})
})

describe("V2ErrorIssue wire format", () => {
	const issueWire = {
		id: encodePublicId("iss", UUID),
		object: "error_issue" as const,
		kind: "error" as const,
		fingerprint_hash: "1234",
		service_name: "checkout-api",
		exception_type: "TimeoutError",
		exception_message: "upstream timed out",
		error_label: "TimeoutError: upstream timed out",
		top_frame: "handler.ts:42",
		workflow_state: "triage" as const,
		priority: 0,
		severity: "critical" as const,
		severity_source: "detector" as const,
		source_ref: null,
		assigned_actor: null,
		lease_holder: null,
		lease_expires_at: null,
		claimed_at: null,
		notes: null,
		first_seen_at: "2026-07-15T00:00:00.000Z",
		last_seen_at: "2026-07-15T01:00:00.000Z",
		occurrence_count: 12,
		resolved_at: null,
		snooze_until: null,
		archived_at: null,
		has_open_incident: true,
	}

	it("encodes the resource with snake_case fields and an iss_ public ID", () => {
		const decoded = Schema.decodeUnknownSync(V2ErrorIssue)(issueWire)
		expect(decoded.id).toBe(UUID)
		const wire = Schema.encodeSync(V2ErrorIssue)(decoded)
		expect(wire.id).toBe(encodePublicId("iss", UUID))
		expect(wire.service_name).toBe("checkout-api")
		expect("serviceName" in wire).toBe(false)
	})

	it("decodes the rich retrieve representation", () => {
		const detail = Schema.decodeUnknownSync(V2ErrorIssueDetail)({
			...issueWire,
			timeseries: [{ bucket: "2026-07-15T01:00:00.000Z", count: 4 }],
			sample_traces: [
				{
					trace_id: "0123456789abcdef0123456789abcdef",
					span_id: "0123456789abcdef",
					service_name: "checkout-api",
					timestamp: "2026-07-15T01:00:00.000Z",
					exception_message: "upstream timed out",
					duration_micros: 1200,
				},
			],
			incidents: [],
		})
		expect(detail.timeseries[0]?.count).toBe(4)
		expect(detail.sample_traces[0]?.trace_id).toBe("0123456789abcdef0123456789abcdef")
	})
})

describe("V2Dashboard wire format", () => {
	it("encodes public IDs and recursively snake_cases the dashboard document", () => {
		const decoded = Schema.decodeUnknownSync(V2DashboardMutation)({
			id: encodePublicId("dash", UUID),
			object: "dashboard",
			name: "Operations",
			description: null,
			tags: ["production"],
			time_range: {
				type: "absolute",
				start_time: "2026-07-15T00:00:00.000Z",
				end_time: "2026-07-16T00:00:00.000Z",
			},
			widgets: [
				{
					id: "widget-1",
					visualization: "line",
					data_source: {
						endpoint: "queryBuilderTimeseries",
						params: { start_time: "now-1h", nested_filter: { attribute_key: "service.name" } },
						transform: { field_map: { value: "requests" } },
					},
					display: {
						chart_id: "requests",
						x_axis: { visible: true },
						list_root_only: true,
					},
					layout: { x: 0, y: 0, w: 6, h: 4, min_w: 2 },
				},
			],
			variables: [
				{
					type: "query",
					name: "service",
					include_all: true,
					source: { kind: "attribute", scope: "resource", attribute_key: "service.name" },
				},
			],
			created_at: "2026-07-15T00:00:00.000Z",
			updated_at: "2026-07-16T00:00:00.000Z",
			txid: "81234",
		})

		expect(decoded.id).toBe(UUID)
		expect(decoded.timeRange.type).toBe("absolute")
		expect(decoded.widgets[0]?.dataSource.transform?.fieldMap).toEqual({ value: "requests" })
		expect(decoded.widgets[0]?.dataSource.params).toEqual({
			startTime: "now-1h",
			nestedFilter: { attributeKey: "service.name" },
		})

		const wire = Schema.encodeSync(V2DashboardMutation)(decoded)
		expect(wire.id).toMatch(/^dash_/)
		expect(wire.time_range).toHaveProperty("start_time")
		expect(wire.widgets[0]?.data_source.transform).toHaveProperty("field_map")
		expect(wire.widgets[0]?.data_source.params).toHaveProperty("nested_filter.attribute_key")
		expect(wire.widgets[0]?.layout).toHaveProperty("min_w")
		expect(wire.variables[0]).toHaveProperty("include_all")
		const variable = wire.variables[0]
		if (variable?.type !== "query") throw new Error("Expected a query dashboard variable")
		expect(variable.source).toHaveProperty("attribute_key")
		expect(wire.txid).toBe("81234")
	})
})

describe("V2 alerts wire format", () => {
	const DEST_UUID = "7c6b5a49-3821-4e0f-9d8c-7b6a59483726"
	const INCIDENT_UUID = "9e8d7c6b-5a49-4382-a1e0-f9d8c7b6a594"

	const ruleWire = {
		id: encodePublicId("alrt", UUID),
		object: "alert_rule",
		name: "Checkout error rate",
		notes: null,
		notification_template: null,
		enabled: true,
		severity: "critical",
		service_names: ["checkout"],
		exclude_service_names: [],
		tags: ["payments"],
		group_by: null,
		signal_type: "error_rate",
		comparator: "gt",
		threshold: 0.05,
		threshold_upper: null,
		window_minutes: 5,
		minimum_sample_count: 50,
		consecutive_breaches_required: 2,
		consecutive_healthy_required: 3,
		renotify_interval_minutes: 60,
		metric_name: null,
		metric_type: null,
		metric_aggregation: null,
		apdex_threshold_ms: null,
		query_builder_draft: { queries: [{ signalType: "traces", attributeKey: "service.name" }] },
		raw_query_sql: null,
		raw_query_reducer: null,
		destination_ids: [encodePublicId("dest", DEST_UUID)],
		no_data_behavior: "skip",
		last_evaluation_error: null,
		last_evaluated_at: null,
		last_scheduled_at: null,
		created_at: "2026-07-15T00:00:00.000Z",
		updated_at: "2026-07-15T00:00:00.000Z",
		created_by: "user_123",
		updated_by: "user_123",
	}

	it("encodes snake_case fields with alrt_/dest_ public IDs and passes the draft through verbatim", () => {
		const rule = Schema.decodeUnknownSync(V2AlertRule)(ruleWire)
		expect(rule.id).toBe(UUID)
		expect(rule.destination_ids).toEqual([DEST_UUID])

		const wire = Schema.encodeSync(V2AlertRule)(rule)
		expect(wire.id).toBe(encodePublicId("alrt", UUID))
		expect(wire.destination_ids[0]).toMatch(/^dest_/)
		expect("signalType" in wire).toBe(false)
		// The query-builder draft is opaque: its camelCase keys survive untouched.
		expect(wire.query_builder_draft).toEqual({
			queries: [{ signalType: "traces", attributeKey: "service.name" }],
		})
	})

	it("keeps txid on rule mutation responses but out of the base resource", () => {
		const mutation = Schema.decodeUnknownSync(V2AlertRuleMutationResponse)({ ...ruleWire, txid: "81234" })
		expect(Schema.encodeSync(V2AlertRuleMutationResponse)(mutation).txid).toBe("81234")
		const base = Schema.decodeUnknownSync(V2AlertRule)(ruleWire)
		expect("txid" in Schema.encodeSync(V2AlertRule)(base)).toBe(false)
	})

	it("rejects wrong-prefix rule IDs", () => {
		expect(() =>
			Schema.decodeUnknownSync(V2AlertRule)({ ...ruleWire, id: encodePublicId("dash", UUID) }),
		).toThrow()
	})

	it("decodes destination create params per union arm and rejects mismatched configs", () => {
		const slack = Schema.decodeUnknownSync(V2AlertDestinationCreateParams)({
			type: "slack",
			name: "On-call",
			webhook_url: "https://hooks.slack.com/services/T/B/X",
			channel_label: "#incidents",
		})
		expect(slack.type).toBe("slack")

		const email = Schema.decodeUnknownSync(V2AlertDestinationCreateParams)({
			type: "email",
			name: "Leads",
			member_user_ids: ["user_1", "user_2"],
		})
		expect(email.type).toBe("email")

		// A pagerduty destination has no webhook_url — the discriminant must match its arm.
		expect(() =>
			Schema.decodeUnknownSync(V2AlertDestinationCreateParams)({
				type: "pagerduty",
				name: "PD",
				webhook_url: "https://hooks.slack.com/services/T/B/X",
			}),
		).toThrow()
	})

	it("encodes incidents with inc_/alrt_ public IDs", () => {
		const incident = Schema.decodeUnknownSync(V2AlertIncident)({
			id: encodePublicId("inc", INCIDENT_UUID),
			object: "alert_incident",
			rule_id: encodePublicId("alrt", UUID),
			rule_name: "Checkout error rate",
			group_key: null,
			signal_type: "error_rate",
			severity: "critical",
			status: "open",
			comparator: "gt",
			threshold: 0.05,
			threshold_upper: null,
			first_triggered_at: "2026-07-15T09:10:00.000Z",
			last_triggered_at: "2026-07-15T09:40:00.000Z",
			resolved_at: null,
			last_observed_value: 0.09,
			last_sample_count: 132,
			dedupe_key: "rule:__total__",
			last_delivered_event_type: "trigger",
			last_notified_at: null,
			error_issue_id: null,
		})
		expect(incident.id).toBe(INCIDENT_UUID)
		expect(incident.rule_id).toBe(UUID)

		const wire = Schema.encodeSync(V2AlertIncident)(incident)
		expect(wire.id).toMatch(/^inc_/)
		expect(wire.rule_id).toMatch(/^alrt_/)
		expect("ruleId" in wire).toBe(false)
	})
})

describe("v2 error envelope", () => {
	it("encodes exactly the Stripe envelope with no _tag", () => {
		const error = notFound("No such api_key", "id")
		const wire = Schema.encodeSync(V2NotFoundError)(error) as Record<string, unknown>
		expect(wire).toEqual({
			error: {
				type: "not_found_error",
				code: "resource_missing",
				message: "No such api_key",
				param: "id",
			},
		})
		expect("_tag" in wire).toBe(false)
	})

	it("omits param when not provided", () => {
		const wire = Schema.encodeSync(V2NotFoundError)(notFound("gone")) as {
			error: Record<string, unknown>
		}
		expect("param" in wire.error).toBe(false)
	})

	it("permissionError has type permission_error", () => {
		expect(permissionError("insufficient_scope", "nope").error.type).toBe("permission_error")
	})

	it("rateLimited has the stable public 429 envelope", () => {
		expect(Schema.encodeSync(V2RateLimitError)(rateLimited())).toEqual({
			error: {
				type: "rate_limit_error",
				code: "rate_limited",
				message: "Too many requests. Retry after 60 seconds.",
			},
		})
	})
})

describe("scopes", () => {
	const check = Schema.decodeUnknownSync(V2Scope)

	it("accepts valid scope strings and rejects invalid ones", () => {
		expect(check("dashboards:read")).toBe("dashboards:read")
		expect(check("alerts:write")).toBe("alerts:write")
		expect(check("*")).toBe("*")
		expect(() => check("dashboards")).toThrow()
		expect(() => check("dashboards:admin")).toThrow()
		expect(() => check("Dashboards:read")).toThrow()
	})

	it("derives the required scope from method + path", () => {
		expect(requiredScopeForRequest("GET", "/v2/api_keys")).toEqual({
			family: "api_keys",
			access: "read",
		})
		expect(requiredScopeForRequest("GET", "/v2/api_keys/key_abc")).toEqual({
			family: "api_keys",
			access: "read",
		})
		expect(requiredScopeForRequest("POST", "/v2/api_keys/key_abc/roll")).toEqual({
			family: "api_keys",
			access: "write",
		})
		expect(requiredScopeForRequest("DELETE", "/v2/api_keys/key_abc")).toEqual({
			family: "api_keys",
			access: "write",
		})
		// Namespaced groups share one family: the first path segment under /v2.
		expect(requiredScopeForRequest("GET", "/v2/alerts/rules")).toEqual({
			family: "alerts",
			access: "read",
		})
		expect(requiredScopeForRequest("POST", "/v2/alerts/destinations/dest_abc/test")).toEqual({
			family: "alerts",
			access: "write",
		})
		expect(requiredScopeForRequest("POST", "/v2/session_replays/search")).toEqual({
			family: "session_replays",
			access: "read",
		})
		expect(requiredScopeForRequest("POST", "/v2/session_replays/for_trace")).toEqual({
			family: "session_replays",
			access: "read",
		})
		for (const [path, family] of [
			["/v2/traces/search", "traces"],
			["/v2/traces/timeseries", "traces"],
			["/v2/traces/breakdown", "traces"],
			["/v2/logs/search", "logs"],
			["/v2/logs/timeseries", "logs"],
			["/v2/logs/breakdown", "logs"],
			["/v2/metrics/timeseries", "metrics"],
			["/v2/metrics/breakdown", "metrics"],
		] as const) {
			expect(requiredScopeForRequest("POST", path)).toEqual({ family, access: "read" })
		}
		expect(requiredScopeForRequest("GET", "/api/api-keys")).toBeNull()
	})

	it("enforces the scope matrix", () => {
		const required = { family: "api_keys", access: "read" } as const
		const write = { family: "api_keys", access: "write" } as const

		expect(scopeAllows(null, write)).toBe(true) // legacy full-access key
		expect(scopeAllows(undefined, write)).toBe(true) // session token
		expect(scopeAllows(["*"], write)).toBe(true)
		expect(scopeAllows(["api_keys:read"], required)).toBe(true)
		expect(scopeAllows(["api_keys:read"], write)).toBe(false)
		expect(scopeAllows(["api_keys:write"], write)).toBe(true)
		expect(scopeAllows(["api_keys:write"], required)).toBe(true) // write implies read
		expect(scopeAllows(["dashboards:write"], required)).toBe(false)
		expect(scopeAllows([], required)).toBe(false)
	})

	it("treats alert preview as a read-only POST", () => {
		expect(requiredScopeForRequest("POST", "/v2/alerts/rules/preview")).toEqual({
			family: "alerts",
			access: "read",
		})
		expect(requiredScopeForRequest("POST", "/v2/alerts/rules/test")).toEqual({
			family: "alerts",
			access: "write",
		})
	})
})

describe("telemetry contracts", () => {
	it("round-trips the synthetic composite log ID", () => {
		const internal = JSON.stringify(["2026-07-15 12:00:00.123", "00112233445566778899AABBCCDDEEFF"])
		const wire = Schema.encodeSync(LogPublicId)(internal)
		expect(wire.startsWith("log_")).toBe(true)
		expect(Schema.decodeSync(LogPublicId)(wire)).toBe(internal)
	})

	it("decodes signal-scoped trace timeseries with attribute grouping", () => {
		const request = Schema.decodeUnknownSync(V2TraceTimeseriesParams)({
			start_time: "2026-07-15T00:00:00.000Z",
			end_time: "2026-07-15T01:00:00.000Z",
			aggregation: "count",
			group_by: "attribute",
			group_by_attribute_key: "http.route",
		})
		expect(request.group_by).toBe("attribute")
	})

	it("rejects invalid filters, grouping, metric compatibility, and budgets", () => {
		const base = {
			start_time: "2026-07-15T00:00:00.000Z",
			end_time: "2026-07-15T01:00:00.000Z",
		}
		expect(() =>
			Schema.decodeUnknownSync(V2TraceTimeseriesParams)({
				...base,
				aggregation: "count",
				group_by: "attribute",
			}),
		).toThrow()
		expect(() =>
			Schema.decodeUnknownSync(V2TraceTimeseriesParams)({
				...base,
				aggregation: "count",
				bucket_seconds: 0,
			}),
		).toThrow()
		expect(() =>
			Schema.decodeUnknownSync(V2MetricsTimeseriesParams)({
				...base,
				aggregation: "rate",
				filters: { metric_name: "requests", metric_type: "gauge" },
			}),
		).toThrow()
		expect(() =>
			Schema.decodeUnknownSync(V2TraceTimeseriesParams)({
				...base,
				aggregation: "count",
				filters: {
					attributes: Array.from({ length: 21 }, (_, index) => ({
						key: `key.${index}`,
						operator: "exists",
					})),
				},
			}),
		).toThrow()
		expect(() =>
			Schema.decodeUnknownSync(V2AttributeFilter)({
				key: "http.status_code",
				operator: "exists",
				value: "500",
			}),
		).toThrow()
	})
})

describe("list pagination", () => {
	const items = Array.from({ length: 45 }, (_, index) => index)

	it.effect("paginates with default limit and opaque cursors", () =>
		Effect.gen(function* () {
			const first = yield* paginateArray(items, {})
			expect(first.data).toHaveLength(20)
			expect(first.has_more).toBe(true)
			expect(first.next_cursor).not.toBeNull()

			const second = yield* paginateArray(items, { cursor: first.next_cursor! })
			expect(second.data[0]).toBe(20)

			const third = yield* paginateArray(items, { cursor: second.next_cursor!, limit: 20 })
			expect(third.data).toHaveLength(5)
			expect(third.has_more).toBe(false)
			expect(third.next_cursor).toBeNull()
		}),
	)

	it("cursor round-trips and rejects garbage", () => {
		expect(decodeOffsetCursor(encodeOffsetCursor(1234))).toBe(1234)
		expect(decodeOffsetCursor("garbage")).toBeNull()
		expect(decodeOffsetCursor("off_-1")).toBeNull()
	})

	it.effect("fails invalid cursors instead of silently restarting at page one", () =>
		Effect.gen(function* () {
			const result = yield* Effect.result(paginateArray(items, { cursor: "garbage" }))
			expect(Result.isFailure(result)).toBe(true)
			if (Result.isFailure(result)) {
				expect(result.failure.error.code).toBe("parameter_invalid")
				expect(result.failure.error.param).toBe("cursor")
			}
		}),
	)

	it.effect("uses storage lookahead and returns each row exactly once", () =>
		Effect.gen(function* () {
			const calls: Array<{ limit: number; offset: number }> = []
			const fetch = ({ limit, offset }: { limit: number; offset: number }) => {
				calls.push({ limit, offset })
				return Effect.succeed(items.slice(offset, offset + limit))
			}
			const first = yield* paginateOffsetQuery({ limit: 10 }, fetch)
			const second = yield* paginateOffsetQuery({ limit: 10, cursor: first.next_cursor! }, fetch)
			expect(calls).toEqual([
				{ limit: 11, offset: 0 },
				{ limit: 11, offset: 10 },
			])
			expect([...first.data, ...second.data]).toEqual(items.slice(0, 20))
		}),
	)

	it("enforces the shared limit range", () => {
		const decode = Schema.decodeUnknownSync(ListQuery)
		expect(decode({})).toEqual({})
		expect(decode({ limit: "1" }).limit).toBe(1)
		expect(decode({ limit: "100" }).limit).toBe(100)
		for (const limit of ["0", "101", "1.5", "nope"]) {
			expect(() => decode({ limit }), `rejects ${limit}`).toThrow()
		}
	})
})

describe("timestamps", () => {
	it("formats epoch-ms as ISO-8601 UTC", () => {
		expect(isoTimestamp(0)).toBe("1970-01-01T00:00:00.000Z")
	})

	it("accepts UTC ISO-8601 timestamps and rejects invalid values", () => {
		expect(Schema.decodeUnknownSync(Timestamp)("2026-07-15T12:34:56.000Z")).toBe(
			"2026-07-15T12:34:56.000Z",
		)
		expect(() => Schema.decodeUnknownSync(Timestamp)("not-a-date")).toThrow()
		expect(() => Schema.decodeUnknownSync(Timestamp)("2026-07-15T12:34:56+02:00")).toThrow()
	})
})
