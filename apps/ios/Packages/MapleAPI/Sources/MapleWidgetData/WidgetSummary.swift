import Foundation

/// `GET /v2/widget_summary`, as this module sees it.
///
/// One request covering both Home Screen widgets, in place of the four the app
/// used to compose (`/v2/error_issues`, `/v2/services`, and two
/// `/v2/traces/timeseries`). It lives here rather than in `MapleAPI` because
/// both readers need it and only one of them can link a generated client: the
/// app fetches through `MapleAPI`, and the widget extension — which holds no
/// Clerk session and no 30k-line client — decodes the same shape by hand.
///
/// Plain `Codable` with explicit coding keys rather than a `keyDecodingStrategy`:
/// the strategy would be set by whoever happens to own the decoder, and this
/// payload is decoded in two processes.
public struct WidgetSummaryPayload: Codable, Sendable, Equatable {
	/// The wire's own version, independent of the API version. A payload from a
	/// newer server whose fields have changed meaning is rejected rather than
	/// rendered — see `isSupported`.
	public var schemaVersion: Int
	/// When the **server** read the data, not when the client received it. Every
	/// "updated 4m ago" on the Home Screen counts from here.
	public var generatedAt: Date
	/// Echoed by the server so a caller can prove the payload belongs to the
	/// organization it asked for before overwriting that organization's cached
	/// snapshot. There is deliberately no name: names come from the app's own
	/// membership index, and a second source could put one organization's name
	/// over another's numbers.
	public var organizationId: String
	public var issues: Issues
	public var throughput: Throughput

	public struct Issues: Codable, Sendable, Equatable {
		public var windowSeconds: Int
		/// More ongoing issues exist than `data` carries, so a count derived from
		/// it is a floor. The widget renders that as "20+".
		public var hasMore: Bool
		public var data: [Issue]

		public init(windowSeconds: Int, hasMore: Bool, data: [Issue]) {
			self.windowSeconds = windowSeconds
			self.hasMore = hasMore
			self.data = data
		}

		private enum CodingKeys: String, CodingKey {
			case windowSeconds = "window_seconds"
			case hasMore = "has_more"
			case data
		}
	}

	/// One issue, carrying the *raw* naming fields rather than a rendered title.
	/// The fallback between them is `WidgetIssueTitle`, which the app's issue
	/// list uses too — a title that resolved differently in the two places would
	/// read as two different issues.
	public struct Issue: Codable, Sendable, Equatable {
		public var id: String
		public var exceptionType: String
		public var errorLabel: String
		public var exceptionMessage: String
		public var serviceName: String
		/// Null for an untriaged issue, and also for a severity this build does
		/// not know: an unknown value decodes to nil rather than crashing a
		/// widget that cannot be updated without an App Store release.
		public var severity: String?
		public var occurrenceCount: Double
		public var lastSeenAt: Date
		public var isRegressed: Bool
		public var hasOpenIncident: Bool

		public init(
			id: String,
			exceptionType: String,
			errorLabel: String,
			exceptionMessage: String,
			serviceName: String,
			severity: String?,
			occurrenceCount: Double,
			lastSeenAt: Date,
			isRegressed: Bool,
			hasOpenIncident: Bool
		) {
			self.id = id
			self.exceptionType = exceptionType
			self.errorLabel = errorLabel
			self.exceptionMessage = exceptionMessage
			self.serviceName = serviceName
			self.severity = severity
			self.occurrenceCount = occurrenceCount
			self.lastSeenAt = lastSeenAt
			self.isRegressed = isRegressed
			self.hasOpenIncident = hasOpenIncident
		}

		private enum CodingKeys: String, CodingKey {
			case id
			case exceptionType = "exception_type"
			case errorLabel = "error_label"
			case exceptionMessage = "exception_message"
			case serviceName = "service_name"
			case severity
			case occurrenceCount = "occurrence_count"
			case lastSeenAt = "last_seen_at"
			case isRegressed = "is_regressed"
			case hasOpenIncident = "has_open_incident"
		}
	}

	public struct Throughput: Codable, Sendable, Equatable {
		public var windowSeconds: Int
		/// The bucket length behind every `points` array. Null when no series
		/// could be read, which is the signal to render the scalars without a
		/// sparkline rather than guess a unit.
		public var bucketSeconds: Int?
		public var services: [Service]
		/// The ungrouped organization series, in the same bucket counts as
		/// `services[].points`. Not the sum of those: the per-service series is
		/// capped at the charted few, so summing it would under-report a large
		/// organization's shape.
		public var totalPoints: [Double]

		public init(windowSeconds: Int, bucketSeconds: Int?, services: [Service], totalPoints: [Double]) {
			self.windowSeconds = windowSeconds
			self.bucketSeconds = bucketSeconds
			self.services = services
			self.totalPoints = totalPoints
		}

		private enum CodingKeys: String, CodingKey {
			case windowSeconds = "window_seconds"
			case bucketSeconds = "bucket_seconds"
			case services
			case totalPoints = "total_points"
		}
	}

	public struct Service: Codable, Sendable, Equatable {
		public var name: String
		public var throughputPerSecond: Double
		/// 0–1, not a percentage.
		public var errorRate: Double
		public var p95LatencyMs: Double
		/// Span **counts** per bucket, oldest first. Divided by `bucketSeconds`
		/// on the way into a snapshot so the sparkline and the headline provably
		/// carry the same unit.
		public var points: [Double]

		public init(
			name: String,
			throughputPerSecond: Double,
			errorRate: Double,
			p95LatencyMs: Double,
			points: [Double]
		) {
			self.name = name
			self.throughputPerSecond = throughputPerSecond
			self.errorRate = errorRate
			self.p95LatencyMs = p95LatencyMs
			self.points = points
		}

		private enum CodingKeys: String, CodingKey {
			case name
			case throughputPerSecond = "throughput_per_second"
			case errorRate = "error_rate"
			case p95LatencyMs = "p95_latency_ms"
			case points
		}
	}

	public init(
		schemaVersion: Int,
		generatedAt: Date,
		organizationId: String,
		issues: Issues,
		throughput: Throughput
	) {
		self.schemaVersion = schemaVersion
		self.generatedAt = generatedAt
		self.organizationId = organizationId
		self.issues = issues
		self.throughput = throughput
	}

	private enum CodingKeys: String, CodingKey {
		case schemaVersion = "schema_version"
		case generatedAt = "generated_at"
		case organizationId = "organization_id"
		case issues
		case throughput
	}

	/// The version this build was written against. A payload above it may have
	/// changed what an existing field *means*, which is the one thing a
	/// tolerant decoder cannot absorb.
	public static let supportedSchemaVersion = 1

	public var isSupported: Bool { schemaVersion <= Self.supportedSchemaVersion }
}

/// How an issue names itself, from the raw contract fields.
///
/// Shared rather than private to either reader: the app's issue list and the
/// Home Screen widget show the same rows, and a title that falls back
/// differently between them reads as two different issues.
public enum WidgetIssueTitle {
	/// The exception type, or — for the kinds that carry none (integration and
	/// alert issues) — the label, or failing that the message.
	public static func title(exceptionType: String, errorLabel: String, exceptionMessage: String) -> String {
		let type = exceptionType.trimmingCharacters(in: .whitespacesAndNewlines)
		if !type.isEmpty { return type }
		let label = errorLabel.trimmingCharacters(in: .whitespacesAndNewlines)
		return label.isEmpty ? exceptionMessage : label
	}

	/// The message, suppressed when it would merely restate the title — which is
	/// what happens once the title has fallen back to the label.
	public static func subtitle(
		exceptionType: String,
		errorLabel: String,
		exceptionMessage: String
	) -> String? {
		let message = exceptionMessage.trimmingCharacters(in: .whitespacesAndNewlines)
		let title = title(
			exceptionType: exceptionType,
			errorLabel: errorLabel,
			exceptionMessage: exceptionMessage
		)
		guard !message.isEmpty, !message.hasPrefix(title), !title.hasPrefix(message) else { return nil }
		return message
	}
}

extension WidgetSummaryPayload {
	/// The issues snapshot this payload describes.
	///
	/// `IssuesSnapshot.make` still does the ranking, truncation, and counting:
	/// the server returns a wider page than the widget draws precisely so that
	/// `openCount` means something, and one place has to reconcile the headline
	/// with the rows.
	///
	/// - Parameter organizationName: from the app's membership index, never from
	///   the payload. The index is corrected the moment memberships load,
	///   whereas a name baked into a snapshot is only as current as the round
	///   that wrote it.
	public func issuesSnapshot(organizationName: String?) -> IssuesSnapshot {
		IssuesSnapshot.make(
			organizationId: organizationId,
			organizationName: organizationName,
			generatedAt: generatedAt,
			issues: issues.data.map { issue in
				WidgetIssue(
					id: issue.id,
					title: WidgetIssueTitle.title(
						exceptionType: issue.exceptionType,
						errorLabel: issue.errorLabel,
						exceptionMessage: issue.exceptionMessage
					),
					subtitle: WidgetIssueTitle.subtitle(
						exceptionType: issue.exceptionType,
						errorLabel: issue.errorLabel,
						exceptionMessage: issue.exceptionMessage
					),
					serviceName: issue.serviceName,
					severity: issue.severity.flatMap(WidgetIssueSeverity.init(rawValue:)),
					occurrenceCount: issue.occurrenceCount,
					lastSeenAt: issue.lastSeenAt,
					isRegressed: issue.isRegressed,
					hasOpenIncident: issue.hasOpenIncident
				)
			},
			hasMore: issues.hasMore
		)
	}

	/// The throughput snapshot this payload describes.
	///
	/// The organization total's *numbers* are summed from every service row —
	/// which is why the server returns more of them than the widget charts —
	/// while only its *shape* comes from the ungrouped series, the one thing
	/// the rows cannot provide.
	public func throughputSnapshot() -> ThroughputSnapshot {
		let services = throughput.services.map { service in
			ServiceThroughput(
				name: service.name,
				throughputPerSecond: service.throughputPerSecond,
				errorRate: service.errorRate,
				p95LatencyMs: service.p95LatencyMs,
				points: perSecond(service.points)
			)
		}
		var overall = ServiceThroughput.total(of: services)
		let total = perSecond(throughput.totalPoints)
		if !total.isEmpty { overall.points = total }
		return ThroughputSnapshot.make(
			organizationId: organizationId,
			generatedAt: generatedAt,
			windowMinutes: throughput.windowSeconds / 60,
			services: services,
			overall: overall
		)
	}

	/// Spans per bucket → spans per second, so the sparkline carries the same
	/// unit as the headline. A missing or nonsensical bucket length leaves the
	/// series out rather than drawing counts as if they were rates.
	private func perSecond(_ values: [Double]) -> [Double] {
		guard let bucketSeconds = throughput.bucketSeconds, bucketSeconds > 0 else { return [] }
		return values.map { $0 / Double(bucketSeconds) }
	}
}
