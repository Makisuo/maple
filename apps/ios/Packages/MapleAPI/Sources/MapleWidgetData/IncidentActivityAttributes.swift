import Foundation

/// The Lock Screen Live Activity Maple runs for a critical incident, in the one
/// module the app and the widget extension both link.
///
/// Three things about this type are load-bearing and none of them fail loudly:
///
/// 1. **The type name is a wire value.** A push that starts an activity names it
///    in `aps.attributes-type`; the server sends the literal string
///    `"IncidentActivityAttributes"` (`LIVE_ACTIVITY_ATTRIBUTES_TYPE` in
///    `MobilePushService.ts`). Rename this type and every start push is dropped
///    by iOS with no error anywhere.
/// 2. **The coding keys are the wire.** ActivityKit decodes the server's
///    `attributes` and `content-state` dictionaries straight into these structs,
///    so the snake_case spelling below has to match what the server renders.
/// 3. **Time is epoch seconds, as a number.** ActivityKit decodes with a plain
///    `JSONDecoder`, whose default date strategy is Apple's 2001 reference date
///    — an ISO-8601 string does not decode, and a failed decode is, again,
///    silence. Seconds cross the wire and become `Date` here.
/// The `ActivityAttributes` conformance is added at the bottom of this file,
/// under `#if os(iOS)`: the protocol is unavailable on macOS, and this module is
/// tested with plain `swift test` on the Mac. The wire shape — which is the part
/// worth testing — stays platform-free.
public struct IncidentActivityAttributes: Codable, Hashable, Sendable {
	/// Everything that moves while the incident is open.
	public struct ContentState: Codable, Hashable, Sendable {
		/// The observed value, already formatted by the server ("9.1%", "1.4s").
		public var value: String
		/// The breach, in the same unit ("> 5%").
		public var threshold: String
		public var status: IncidentActivityStatus
		/// When the value was measured.
		public var updatedAt: Date
		/// Recent checks, **oldest first**, in the signal's own unit — the last
		/// element is the value above. Empty when the incident is too young to
		/// have a history, in which case the chart is simply not drawn.
		public var series: [Double]
		/// The threshold as a raw number, so the chart can rule it off in the
		/// same units as `series`. The `threshold` string above is the same
		/// number formatted for reading.
		public var thresholdValue: Double?

		public init(
			value: String,
			threshold: String,
			status: IncidentActivityStatus,
			updatedAt: Date,
			series: [Double] = [],
			thresholdValue: Double? = nil
		) {
			self.value = value
			self.threshold = threshold
			self.status = status
			self.updatedAt = updatedAt
			self.series = series
			self.thresholdValue = thresholdValue
		}

		private enum CodingKeys: String, CodingKey {
			case value
			case threshold
			case status
			case updatedAt = "updated_at"
			case series
			case thresholdValue = "threshold_value"
		}

		public init(from decoder: any Decoder) throws {
			let container = try decoder.container(keyedBy: CodingKeys.self)
			value = try container.decode(String.self, forKey: .value)
			threshold = try container.decode(String.self, forKey: .threshold)
			status = try container.decode(IncidentActivityStatus.self, forKey: .status)
			updatedAt = Date(timeIntervalSince1970: try container.decode(Double.self, forKey: .updatedAt))
			// Tolerated rather than required: a decode failure is a Lock Screen
			// that stays empty with nothing logged, so a server that has not
			// started sending the chart yet must still produce a valid state.
			series = try container.decodeIfPresent([Double].self, forKey: .series) ?? []
			thresholdValue = try container.decodeIfPresent(Double.self, forKey: .thresholdValue)
		}

		public func encode(to encoder: any Encoder) throws {
			var container = encoder.container(keyedBy: CodingKeys.self)
			try container.encode(value, forKey: .value)
			try container.encode(threshold, forKey: .threshold)
			try container.encode(status, forKey: .status)
			try container.encode(updatedAt.timeIntervalSince1970, forKey: .updatedAt)
			try container.encode(series, forKey: .series)
			try container.encodeIfPresent(thresholdValue, forKey: .thresholdValue)
		}
	}

	/// The public `inc_…` id — what a tap hands back to the v2 API.
	public var incidentId: String
	public var ruleName: String
	/// The service or group the incident is scoped to; nil for an org-wide rule.
	public var service: String?
	/// What is being measured ("Error Rate", "p95 Latency").
	public var signalLabel: String
	public var startedAt: Date
	/// Which organization's incident this is, so a tap lands in the right one.
	///
	/// **Optional, and it has to stay optional.** Attributes are the static half
	/// of an activity: an activity already running when this shipped has no such
	/// field and no later push can add one. Making it required would also mean
	/// iOS silently dropping every start push from a server that has not yet
	/// shipped the matching change — and, per the notes at the top of this file,
	/// a failed decode here is silence, not an error.
	public var organizationId: String?

	public init(
		incidentId: String,
		ruleName: String,
		service: String?,
		signalLabel: String,
		startedAt: Date,
		organizationId: String? = nil
	) {
		self.incidentId = incidentId
		self.ruleName = ruleName
		self.service = service
		self.signalLabel = signalLabel
		self.startedAt = startedAt
		self.organizationId = organizationId
	}

	private enum CodingKeys: String, CodingKey {
		case incidentId = "incident_id"
		case ruleName = "rule_name"
		case service
		case signalLabel = "signal_label"
		case startedAt = "started_at"
		case organizationId = "organization_id"
	}

	public init(from decoder: any Decoder) throws {
		let container = try decoder.container(keyedBy: CodingKeys.self)
		incidentId = try container.decode(String.self, forKey: .incidentId)
		ruleName = try container.decode(String.self, forKey: .ruleName)
		service = try container.decodeIfPresent(String.self, forKey: .service)
		signalLabel = try container.decode(String.self, forKey: .signalLabel)
		startedAt = Date(timeIntervalSince1970: try container.decode(Double.self, forKey: .startedAt))
		organizationId = try container.decodeIfPresent(String.self, forKey: .organizationId)
	}

	public func encode(to encoder: any Encoder) throws {
		var container = encoder.container(keyedBy: CodingKeys.self)
		try container.encode(incidentId, forKey: .incidentId)
		try container.encode(ruleName, forKey: .ruleName)
		try container.encodeIfPresent(service, forKey: .service)
		try container.encode(signalLabel, forKey: .signalLabel)
		try container.encode(startedAt.timeIntervalSince1970, forKey: .startedAt)
		try container.encodeIfPresent(organizationId, forKey: .organizationId)
	}
}

/// Whether the incident is still breaching. Raw values are the wire values.
public enum IncidentActivityStatus: String, Codable, Hashable, Sendable {
	case firing
	case resolved
}

extension IncidentActivityAttributes {
	/// Where a tap on the activity lands: the incident, on the Alerts tab.
	public var deepLinkURL: URL? {
		// No `?org=` for a legacy activity, which keeps its pre-multi-org meaning:
		// open in whichever organization is active.
		WidgetDeepLink(target: .incident(id: incidentId), organizationId: organizationId).url
	}

	/// Previews and the widget gallery.
	public static var sample: IncidentActivityAttributes {
		IncidentActivityAttributes(
			incidentId: "inc_YofPTrK9782DWwcnXhpcCw",
			ruleName: "Checkout error rate",
			service: "checkout-api",
			signalLabel: "Error Rate",
			startedAt: Date().addingTimeInterval(-14 * 60),
			organizationId: "org_sample"
		)
	}
}

extension IncidentActivityAttributes.ContentState {
	public static var sample: Self {
		.init(
			value: "9.1%",
			threshold: "> 5%",
			status: .firing,
			updatedAt: Date(),
			series: [0.021, 0.019, 0.024, 0.022, 0.031, 0.048, 0.052, 0.061, 0.074, 0.083, 0.088, 0.091],
			thresholdValue: 0.05
		)
	}

	public static var resolvedSample: Self {
		.init(
			value: "1.2%",
			threshold: "> 5%",
			status: .resolved,
			updatedAt: Date(),
			series: [0.091, 0.088, 0.081, 0.07, 0.062, 0.055, 0.044, 0.031, 0.022, 0.018, 0.014, 0.012],
			thresholdValue: 0.05
		)
	}
}

#if os(iOS)
	import ActivityKit

	extension IncidentActivityAttributes: ActivityAttributes {}
#endif
