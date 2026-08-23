import Foundation
import Testing

@testable import MapleAPI

/// Decodes payloads shaped like the real API responses.
///
/// These are the regression test for the spec normalization in
/// `scripts/generate-ios-openapi.ts`. If someone drops the nullable-union
/// collapse, `notes` becomes a `Union_N` struct and this file stops compiling;
/// if they drop the number-union collapse, `errorRate` stops being a `Double`.
/// A compile failure is the point — it cannot be skipped.
@Suite("Decoding")
struct DecodingTests {
	private let decoder = JSONDecoder()

	@Test("Decodes a service list")
	func serviceList() throws {
		let json = Data(
			"""
			{"object":"list","has_more":false,"next_cursor":null,"data":[
			  {"object":"service","name":"maple-api","service_namespaces":["maple"],
			   "deployment_environments":["production"],"throughput":12.5,"traced_throughput":12.5,
			   "span_count":45000,"error_count":12,"error_rate":0.00027,"p50_latency_ms":18.4,
			   "p95_latency_ms":142.9,"p99_latency_ms":890.1,"has_sampling":false,"sampling_weight":1}]}
			""".utf8
		)

		let list = try decoder.decode(Components.Schemas.ServiceList.self, from: json)
		let service = try #require(list.data.first)

		// The whole point of the number-union collapse: a Double, not a wrapper.
		let rate: Double = service.errorRate
		#expect(rate == 0.00027)
		#expect(service.name == "maple-api")
		#expect(service.p95LatencyMs == 142.9)
		#expect(list.hasMore == false)
		#expect(list.nextCursor == nil)
	}

	/// Every nullable field explicitly `null` — `Schema.NullOr` always emits the
	/// key, so this is the shape the API really sends, not a hypothetical.
	@Test("Decodes an issue with every nullable field null")
	func issueWithNulls() throws {
		let list = try decoder.decode(Components.Schemas.ErrorIssueList.self, from: Self.issueListJSON)
		let issue = try #require(list.data.first)

		// The nullable-union collapse: plain Optionals, not Union_N wrappers.
		let notes: String? = issue.notes
		let severity: IssueSeverity? = issue.severity
		let actor: ErrorIssueActor? = issue.assignedActor
		#expect(notes == nil)
		#expect(severity == nil)
		#expect(actor == nil)
		#expect(issue.resolvedAt == nil)
		#expect(issue.snoozeUntil == nil)

		// Non-nullable neighbours must have stayed required.
		#expect(issue.occurrenceCount == 417)
		#expect(issue.exceptionType == "TypeError")
		#expect(issue.workflowState == .triage)
		#expect(issue.hasOpenIncident == false)
	}

	@Test("Decodes an issue with every nullable field populated")
	func issueWithValues() throws {
		let json = Data(
			"""
			{"object":"list","has_more":true,"next_cursor":"off_1k","data":[
			  {"id":"iss_2xK9","object":"error_issue","kind":"error","fingerprint_hash":"a1b2",
			   "service_name":"maple-web","exception_type":"RangeError","exception_message":"out of range",
			   "error_label":"RangeError","top_frame":"chart.tsx:88","workflow_state":"in_progress",
			   "priority":80,"severity":"critical","severity_source":"detector","source_ref":{"pr":42},
			   "assigned_actor":{"id":"actor_1","type":"agent","user_id":null,"agent_name":"triage-bot",
			     "model":"opus","capabilities":["triage"],"last_active_at":"2026-08-17T09:00:00.000Z"},
			   "lease_holder":null,"lease_expires_at":"2026-08-17T10:00:00.000Z",
			   "claimed_at":"2026-08-17T09:00:00.000Z","notes":"looking into it",
			   "first_seen_at":"2026-08-10T00:00:00.000Z","last_seen_at":"2026-08-17T09:30:00.000Z",
			   "occurrence_count":9,"resolved_at":null,"snooze_until":null,"archived_at":null,
			   "regression_count":0,"resolved_versions":[],"has_open_incident":true}]}
			""".utf8
		)

		let issue = try #require(try decoder.decode(Components.Schemas.ErrorIssueList.self, from: json).data.first)

		#expect(issue.severity == .critical)
		#expect(issue.notes == "looking into it")
		#expect(issue.assignedActor?.agentName == "triage-bot")
		#expect(issue.assignedActor?._type == .agent)
		// A nullable field *inside* a nullable object still collapses correctly.
		#expect(issue.assignedActor?.userId == nil)
		#expect(issue.leaseHolder == nil)

		let parsed = try #require(ResolvedTimeWindow.parse(issue.lastSeenAt))
		#expect(ResolvedTimeWindow.format(parsed) == "2026-08-17T09:30:00.000Z")
	}

	@Test("Decodes issue detail with its timeseries, samples, incidents, and environments")
	func issueDetail() throws {
		let json = Data(
			"""
			{"id":"iss_2xK9","object":"error_issue","kind":"error","fingerprint_hash":"a1b2",
			 "service_name":"maple-api","exception_type":"TypeError","exception_message":"boom",
			 "error_label":"TypeError","top_frame":"handler.ts:12","workflow_state":"triage","priority":50,
			 "severity":"high","severity_source":"ai","source_ref":null,"assigned_actor":null,
			 "lease_holder":null,"lease_expires_at":null,"claimed_at":null,"notes":null,
			 "first_seen_at":"2026-08-01T00:00:00.000Z","last_seen_at":"2026-08-17T00:00:00.000Z",
			 "occurrence_count":417,"resolved_at":null,"snooze_until":null,"archived_at":null,
			 "regression_count":2,"resolved_versions":["1.4.0"],"has_open_incident":true,
			 "timeseries":[{"bucket":"2026-08-17T00:00:00.000Z","count":12}],
			 "sample_traces":[{"trace_id":"abc","span_id":"def","service_name":"maple-api",
			   "timestamp":"2026-08-17T00:00:00.000Z","exception_message":"boom","duration_micros":15400}],
			 "incidents":[{"id":"einc_1","object":"error_incident","issue_id":"iss_2xK9","status":"open",
			   "reason":"regression","first_triggered_at":"2026-08-16T00:00:00.000Z",
			   "last_triggered_at":"2026-08-17T00:00:00.000Z","resolved_at":null,"occurrence_count":12}],
			 "environments":[{"name":"production","count":405},{"name":"staging","count":12}]}
			""".utf8
		)

		let detail = try decoder.decode(ErrorIssueDetail.self, from: json)

		#expect(detail.timeseries.count == 1)
		#expect(detail.timeseries.first?.count == 12)
		#expect(detail.sampleTraces.first?.durationMicros == 15400)
		#expect(detail.incidents.first?.status == .open)
		#expect(detail.incidents.first?.reason == .regression)
		#expect(detail.incidents.first?.resolvedAt == nil)
		#expect(detail.environments.map(\.name) == ["production", "staging"])
	}

	@Test("Decodes per-service issue counts")
	func serviceCounts() throws {
		let json = Data(
			"""
			{"object":"list","has_more":false,"next_cursor":null,
			 "data":[{"service_name":"maple-api","open_count":3}]}
			""".utf8
		)

		let list = try decoder.decode(Components.Schemas.ErrorIssueServiceCountList.self, from: json)
		#expect(list.data.first?.serviceName == "maple-api")
		#expect(list.data.first?.openCount == 3)
	}

	private static let issueListJSON = Data(
		"""
		{"object":"list","has_more":false,"next_cursor":null,"data":[
		  {"id":"iss_2xK9","object":"error_issue","kind":"error","fingerprint_hash":"a1b2",
		   "service_name":"maple-api","exception_type":"TypeError","exception_message":"boom",
		   "error_label":"TypeError","top_frame":"handler.ts:12","workflow_state":"triage",
		   "priority":50,"severity":null,"severity_source":null,"source_ref":null,
		   "assigned_actor":null,"lease_holder":null,"lease_expires_at":null,"claimed_at":null,
		   "notes":null,"first_seen_at":"2026-08-01T00:00:00.000Z",
		   "last_seen_at":"2026-08-17T00:00:00.000Z","occurrence_count":417,"resolved_at":null,
		   "snooze_until":null,"archived_at":null,"regression_count":0,"resolved_versions":[],
		   "has_open_incident":false}]}
		""".utf8
	)
}
