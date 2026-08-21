import Foundation
import Testing

@testable import MapleWidgetData

private let now = Date(timeIntervalSince1970: 1_800_000_000)

private func issue(
	id: String = "iss_1",
	exceptionType: String = "TypeError",
	errorLabel: String = "checkout",
	exceptionMessage: String = "Cannot read properties of undefined",
	severity: String? = "critical",
	count: Double = 412,
	lastSeen: Date = now.addingTimeInterval(-600),
	regressed: Bool = false,
	paging: Bool = false
) -> WidgetSummaryPayload.Issue {
	WidgetSummaryPayload.Issue(
		id: id,
		exceptionType: exceptionType,
		errorLabel: errorLabel,
		exceptionMessage: exceptionMessage,
		serviceName: "api",
		severity: severity,
		occurrenceCount: count,
		lastSeenAt: lastSeen,
		isRegressed: regressed,
		hasOpenIncident: paging
	)
}

private func payload(
	issues: [WidgetSummaryPayload.Issue] = [issue()],
	hasMore: Bool = false,
	bucketSeconds: Int? = 300,
	services: [WidgetSummaryPayload.Service] = [],
	totalPoints: [Double] = [],
	schemaVersion: Int = WidgetSummaryPayload.supportedSchemaVersion
) -> WidgetSummaryPayload {
	WidgetSummaryPayload(
		schemaVersion: schemaVersion,
		generatedAt: now,
		organizationId: "org_1",
		issues: .init(windowSeconds: 86_400, hasMore: hasMore, data: issues),
		throughput: .init(
			windowSeconds: 3_600,
			bucketSeconds: bucketSeconds,
			services: services,
			totalPoints: totalPoints
		)
	)
}

private func service(
	_ name: String,
	throughput: Double = 12,
	errorRate: Double = 0.01,
	p95: Double = 100,
	points: [Double] = []
) -> WidgetSummaryPayload.Service {
	WidgetSummaryPayload.Service(
		name: name,
		throughputPerSecond: throughput,
		errorRate: errorRate,
		p95LatencyMs: p95,
		points: points
	)
}

@Suite("Widget summary wire")
struct WidgetSummaryWireTests {
	@Test("decodes the server's snake_case payload")
	func decodesWire() throws {
		let json = """
		{
		  "object": "widget_summary",
		  "schema_version": 1,
		  "generated_at": "2027-01-15T08:00:00.000Z",
		  "organization_id": "org_1",
		  "issues": {
		    "window_seconds": 86400,
		    "has_more": true,
		    "data": [{
		      "id": "iss_1",
		      "exception_type": "TypeError",
		      "error_label": "checkout",
		      "exception_message": "boom",
		      "service_name": "api",
		      "severity": "critical",
		      "occurrence_count": 412,
		      "last_seen_at": "2027-01-15T07:58:00.000Z",
		      "is_regressed": false,
		      "has_open_incident": true
		    }]
		  },
		  "throughput": {
		    "window_seconds": 3600,
		    "bucket_seconds": 300,
		    "services": [{
		      "name": "api",
		      "throughput_per_second": 12.5,
		      "error_rate": 0.01,
		      "p95_latency_ms": 184,
		      "points": [3600, 3720]
		    }],
		    "total_points": [5200, 5310]
		  }
		}
		"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		let decoded = try decoder.decode(WidgetSummaryPayload.self, from: Data(json.utf8))

		#expect(decoded.isSupported)
		#expect(decoded.organizationId == "org_1")
		#expect(decoded.issues.hasMore)
		#expect(decoded.issues.data.first?.exceptionType == "TypeError")
		#expect(decoded.throughput.bucketSeconds == 300)
		#expect(decoded.throughput.services.first?.points == [3600, 3720])
	}

	@Test("a bucket_seconds of null decodes rather than failing the whole payload")
	func decodesNullBucketSeconds() throws {
		let json = """
		{"schema_version":1,"generated_at":"2027-01-15T08:00:00.000Z","organization_id":"org_1",
		 "issues":{"window_seconds":86400,"has_more":false,"data":[]},
		 "throughput":{"window_seconds":3600,"bucket_seconds":null,"services":[],"total_points":[]}}
		"""
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		let decoded = try decoder.decode(WidgetSummaryPayload.self, from: Data(json.utf8))
		#expect(decoded.throughput.bucketSeconds == nil)
	}

	@Test("a payload from a newer server is not supported")
	func rejectsFutureSchema() {
		#expect(payload(schemaVersion: WidgetSummaryPayload.supportedSchemaVersion + 1).isSupported == false)
	}
}

@Suite("Widget summary → issues snapshot")
struct WidgetSummaryIssuesTests {
	@Test("names an issue the same way the app's list does")
	func rendersTitles() {
		// Falls back to the label when there is no exception type, and then
		// suppresses a message that would merely restate it.
		let snapshot = payload(issues: [
			issue(exceptionType: "  ", errorLabel: "Timeout", exceptionMessage: "Timeout: upstream"),
			issue(id: "iss_2", exceptionType: "TypeError", exceptionMessage: "boom"),
		]).issuesSnapshot(organizationName: "Maple")

		let byId = Dictionary(uniqueKeysWithValues: snapshot.issues.map { ($0.id, $0) })
		#expect(byId["iss_1"]?.title == "Timeout")
		#expect(byId["iss_1"]?.subtitle == nil)
		#expect(byId["iss_2"]?.title == "TypeError")
		#expect(byId["iss_2"]?.subtitle == "boom")
	}

	@Test("takes the organization name from the caller, never the payload")
	func namesFromCaller() {
		#expect(payload().issuesSnapshot(organizationName: "Acme").organizationName == "Acme")
		#expect(payload().issuesSnapshot(organizationName: nil).organizationName == nil)
	}

	@Test("a severity this build does not know ranks below low rather than crashing")
	func unknownSeverity() {
		let snapshot = payload(issues: [issue(severity: "apocalyptic")]).issuesSnapshot(organizationName: nil)
		#expect(snapshot.issues.first?.severity == nil)
		#expect(snapshot.criticalCount == 0)
	}

	@Test("carries has_more through so the widget renders a floor")
	func carriesHasMore() {
		#expect(payload(hasMore: true).issuesSnapshot(organizationName: nil).isCapped)
		#expect(payload(hasMore: false).issuesSnapshot(organizationName: nil).isCapped == false)
	}

	@Test("counts every issue fetched, not just the rows drawn")
	func countsBeyondTheRows() {
		let rows = (0..<10).map { issue(id: "iss_\($0)") }
		let snapshot = payload(issues: rows).issuesSnapshot(organizationName: nil)
		#expect(snapshot.openCount == 10)
		#expect(snapshot.criticalCount == 10)
		#expect(snapshot.issues.count == IssuesSnapshot.maximumIssues)
	}
}

@Suite("Widget summary → throughput snapshot")
struct WidgetSummaryThroughputTests {
	@Test("divides bucket counts into the same unit as the headline")
	func convertsToPerSecond() {
		let snapshot = payload(
			bucketSeconds: 300,
			services: [service("api", throughput: 12, points: [3_600, 1_800])]
		).throughputSnapshot()
		#expect(snapshot.services.first?.points == [12, 6])
	}

	@Test("drops the series when the bucket length is missing or nonsensical")
	func dropsUnitlessSeries() {
		for bucketSeconds in [nil, 0, -1] {
			let snapshot = payload(
				bucketSeconds: bucketSeconds,
				services: [service("api", points: [3_600])],
				totalPoints: [3_600]
			).throughputSnapshot()
			// The scalars survive — only the shape is unrenderable.
			#expect(snapshot.services.first?.points.isEmpty == true)
			#expect(snapshot.overall.points.isEmpty)
			#expect(snapshot.services.first?.throughputPerSecond == 12)
		}
	}

	@Test("sums the total from every service, but takes its shape from the ungrouped series")
	func totalsAcrossEveryService() {
		// Two services the widget charts, and an ungrouped series that is larger
		// than their sum because the org has traffic past the charted few.
		let snapshot = payload(
			bucketSeconds: 60,
			services: [
				service("api", throughput: 10, points: [600]),
				service("web", throughput: 5, points: [300]),
			],
			totalPoints: [1_800]
		).throughputSnapshot()

		#expect(snapshot.overall.throughputPerSecond == 15)
		// 30/s, not the 15/s the two charted services sum to.
		#expect(snapshot.overall.points == [30])
	}

	@Test("falls back to the summed shape when the ungrouped series is empty")
	func fallsBackToSummedShape() {
		let snapshot = payload(
			bucketSeconds: 60,
			services: [service("api", throughput: 10, points: [600])],
			totalPoints: []
		).throughputSnapshot()
		#expect(snapshot.overall.points == [10])
	}

	@Test("ranks busiest first and caps what crosses the boundary")
	func ranksAndCaps() {
		let rows = (0..<20).map { service("svc-\($0)", throughput: Double($0)) }
		let snapshot = payload(services: rows).throughputSnapshot()
		#expect(snapshot.services.count == ThroughputSnapshot.maximumServices)
		#expect(snapshot.services.first?.name == "svc-19")
		// The total still counts every service, including the uncharted ones.
		#expect(snapshot.overall.throughputPerSecond == 190)
	}

	@Test("reports the window the server used, in minutes")
	func reportsWindow() {
		#expect(payload().throughputSnapshot().windowMinutes == 60)
	}
}
