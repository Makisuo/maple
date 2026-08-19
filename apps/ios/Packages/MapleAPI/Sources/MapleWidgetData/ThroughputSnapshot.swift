import Foundation

/// What the throughput widget draws: how much traffic is flowing right now,
/// for the whole organization or for the one service the user picked in the
/// widget's own configuration.
///
/// Published by the app into the same App Group as `IssuesSnapshot`, for the
/// same reason: an extension holds no Clerk session. The widget's service
/// picker is populated from `services` here, so the choices are whatever the
/// app last saw — no query from the extension, and no service in the list that
/// stopped reporting a week ago.
public struct ThroughputSnapshot: Codable, Sendable, Equatable {
	public var organizationId: String
	public var generatedAt: Date
	/// The window the numbers describe, so the widget can say "last hour"
	/// without hardcoding what the app happened to ask for.
	public var windowMinutes: Int
	/// The organization total. Same shape as a service, so the configured and
	/// unconfigured cases draw through one view.
	public var overall: ServiceThroughput
	/// Ranked busiest first, capped at `maximumServices`.
	public var services: [ServiceThroughput]

	public init(
		organizationId: String,
		generatedAt: Date,
		windowMinutes: Int,
		overall: ServiceThroughput,
		services: [ServiceThroughput]
	) {
		self.organizationId = organizationId
		self.generatedAt = generatedAt
		self.windowMinutes = windowMinutes
		self.overall = overall
		self.services = services
	}

	/// The picker is only useful while it is short, and every row costs bytes
	/// in a store the widget reads on every timeline build.
	public static let maximumServices = 12

	public static func make(
		organizationId: String,
		generatedAt: Date,
		windowMinutes: Int,
		services: [ServiceThroughput],
		overall: ServiceThroughput? = nil
	) -> ThroughputSnapshot {
		let ranked = services.sorted { left, right in
			if left.throughputPerSecond != right.throughputPerSecond {
				return left.throughputPerSecond > right.throughputPerSecond
			}
			// A total order, so the same input never yields two orders.
			return left.displayName < right.displayName
		}
		return ThroughputSnapshot(
			organizationId: organizationId,
			generatedAt: generatedAt,
			windowMinutes: windowMinutes,
			// Derived by default: a total assembled from the same rows the
			// widget shows can never disagree with them.
			overall: overall ?? ServiceThroughput.total(of: ranked),
			services: Array(ranked.prefix(maximumServices))
		)
	}

	/// The row a configured widget should draw; `nil` name means the total.
	///
	/// Returns nil when the widget names a service the snapshot no longer
	/// carries — it went quiet, or the user switched organization. The widget
	/// says so rather than silently falling back to the org total, which would
	/// look like the service was fine.
	public func service(named name: String?) -> ServiceThroughput? {
		guard let name else { return overall }
		return services.first { $0.name == name }
	}

	public var isEmpty: Bool { services.isEmpty }

	public func age(at date: Date) -> TimeInterval { max(0, date.timeIntervalSince(generatedAt)) }

	/// Same threshold as the issues widget — one idea of "stale" across the
	/// Home Screen.
	public func isStale(at date: Date) -> Bool { age(at: date) > IssuesSnapshot.staleAfter }
}

/// One service's traffic, or the organization's total when `name` is nil.
public struct ServiceThroughput: Codable, Sendable, Equatable, Identifiable {
	public var name: String?
	/// Spans per second — the same number the Services tab shows.
	public var throughputPerSecond: Double
	/// 0–1, not a percentage.
	public var errorRate: Double
	public var p95LatencyMs: Double
	/// Throughput per bucket across the window, oldest first, in the **same
	/// unit as `throughputPerSecond`**: the app divides each bucket's span
	/// count by the bucket length, so the sparkline and the headline cannot
	/// disagree about what they measure.
	public var points: [Double]

	public var id: String { name ?? "" }

	public init(
		name: String?,
		throughputPerSecond: Double,
		errorRate: Double,
		p95LatencyMs: Double,
		points: [Double] = []
	) {
		self.name = name
		self.throughputPerSecond = throughputPerSecond
		self.errorRate = errorRate
		self.p95LatencyMs = p95LatencyMs
		self.points = points
	}

	public var displayName: String { name ?? "All services" }

	/// The organization total: throughput sums, error rate is weighted by
	/// throughput (a silent service failing every one of its three requests
	/// must not drag the org to 50%), and p95 is the worst service's —
	/// percentiles do not average.
	public static func total(of services: [ServiceThroughput]) -> ServiceThroughput {
		let throughput = services.reduce(0) { $0 + $1.throughputPerSecond }
		let errors = services.reduce(0) { $0 + $1.errorRate * $1.throughputPerSecond }
		let bucketCount = services.map(\.points.count).max() ?? 0
		let summed = (0..<bucketCount).map { index in
			services.reduce(0) { total, service in
				total + (index < service.points.count ? service.points[index] : 0)
			}
		}
		return ServiceThroughput(
			name: nil,
			throughputPerSecond: throughput,
			errorRate: throughput > 0 ? errors / throughput : 0,
			p95LatencyMs: services.map(\.p95LatencyMs).max() ?? 0,
			points: summed
		)
	}

	/// How the second half of the window compares with the first, as a signed
	/// ratio: `+0.2` reads as "a fifth busier than it was".
	///
	/// Nil when there is not enough window to say, or when the first half was
	/// silent — traffic arriving from nothing is not a percentage.
	public var trend: Double? {
		guard points.count >= 4 else { return nil }
		let half = points.count / 2
		let before = points.prefix(half)
		let after = points.suffix(points.count - half)
		let averageBefore = before.reduce(0, +) / Double(before.count)
		let averageAfter = after.reduce(0, +) / Double(after.count)
		guard averageBefore > 0 else { return nil }
		return (averageAfter - averageBefore) / averageBefore
	}
}
