import Foundation

/// A query window for the telemetry endpoints.
///
/// `/v2/services` and `/v2/services/{name}` **require** `start_time` and
/// `end_time` — there is no server-side default — so this is not a convenience,
/// it is part of every call.
public enum TimeWindow: String, CaseIterable, Identifiable, Sendable {
	case lastHour
	case last6Hours
	case last24Hours
	case last7Days

	public var id: String { rawValue }

	public var duration: TimeInterval {
		switch self {
		case .lastHour: 3600
		case .last6Hours: 6 * 3600
		case .last24Hours: 24 * 3600
		case .last7Days: 7 * 24 * 3600
		}
	}

	public var title: String {
		switch self {
		case .lastHour: "Last hour"
		case .last6Hours: "Last 6 hours"
		case .last24Hours: "Last 24 hours"
		case .last7Days: "Last 7 days"
		}
	}

	/// Used in empty-state copy, where "No services reported in the last 24
	/// hours" has to read as a fact about the window, not as an error.
	public var phrase: String {
		switch self {
		case .lastHour: "the last hour"
		case .last6Hours: "the last 6 hours"
		case .last24Hours: "the last 24 hours"
		case .last7Days: "the last 7 days"
		}
	}

	/// 24 hours: an hour is too sparse for a low-traffic service to show
	/// anything, and 7 days is the server's hard ceiling
	/// (`MAX_LIST_RANGE_SECONDS`, `packages/query-engine/src/limits.ts`).
	public static let `default` = TimeWindow.last24Hours

	/// Resolve against a reference instant.
	///
	/// The end is snapped **down to the minute**. An un-snapped `Date()` makes
	/// every request URL unique, which defeats the API's edge and bucket caches
	/// and restarts every SwiftUI `.task(id:)` that keys off the window.
	public func resolve(now: Date = Date()) -> ResolvedTimeWindow {
		let end = Date(timeIntervalSince1970: (now.timeIntervalSince1970 / 60).rounded(.down) * 60)
		return ResolvedTimeWindow(start: end.addingTimeInterval(-duration), end: end)
	}
}

/// A concrete instant pair, formatted the way the API's validator demands.
public struct ResolvedTimeWindow: Hashable, Sendable {
	public let start: Date
	public let end: Date

	public init(start: Date, end: Date) {
		self.start = start
		self.end = end
	}

	public var startTime: String { Self.format(start) }
	public var endTime: String { Self.format(end) }

	/// ISO-8601 with fractional seconds, always UTC.
	///
	/// The server checks `^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]00:00)$`, so a
	/// local-timezone string is rejected at runtime with a 400 rather than at
	/// compile time. Hence the explicit `.gmt` and the test that runs under a
	/// half-hour-offset timezone.
	public static func format(_ date: Date) -> String {
		fractional.format(date)
	}

	/// `ISO8601DateFormatter` is not `Sendable`, so a shared instance will not
	/// compile under Swift 6. `Date.ISO8601FormatStyle` is a value type and is.
	private static let fractional = Date.ISO8601FormatStyle(
		includingFractionalSeconds: true,
		timeZone: .gmt
	)

	/// Some fields (bucket boundaries) come back without fractional seconds.
	private static let whole = Date.ISO8601FormatStyle(
		includingFractionalSeconds: false,
		timeZone: .gmt
	)

	/// Parse a timestamp the API returned.
	///
	/// The pruned spec keeps timestamps as plain strings rather than
	/// `format: date-time`, precisely so this stays under our control: the
	/// generator's `Foundation.Date` mapping does not accept the
	/// fractional-seconds form the API emits.
	public static func parse(_ text: String) -> Date? {
		(try? fractional.parse(text)) ?? (try? whole.parse(text))
	}
}
