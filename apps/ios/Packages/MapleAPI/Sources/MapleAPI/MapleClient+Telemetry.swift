import Foundation
import OpenAPIRuntime

/// A trace timeseries query, narrowed to the shape the app needs: one service,
/// one aggregation, one window. `bucketSeconds` defaults to whatever gives the
/// window roughly `TraceTimeseriesRequest.targetPoints` points, so a sparkline
/// on a 1h window and one on a 7d window carry the same visual density.
public struct TraceTimeseriesRequest: Hashable, Sendable {
	public var aggregation: TraceAggregation
	public var window: ResolvedTimeWindow
	public var serviceName: String?
	public var hasError: Bool?
	public var bucketSeconds: Int?

	public static let targetPoints = 40

	public init(
		aggregation: TraceAggregation,
		window: ResolvedTimeWindow,
		serviceName: String? = nil,
		hasError: Bool? = nil,
		bucketSeconds: Int? = nil
	) {
		self.aggregation = aggregation
		self.window = window
		self.serviceName = serviceName
		self.hasError = hasError
		self.bucketSeconds = bucketSeconds
	}

	/// Snapped to a minute multiple: the server rounds anyway, and a whole
	/// number of minutes keeps bucket boundaries aligned with the window's
	/// minute-snapped end.
	public var resolvedBucketSeconds: Int {
		if let bucketSeconds { return bucketSeconds }
		let raw = window.end.timeIntervalSince(window.start) / Double(Self.targetPoints)
		return max(60, Int((raw / 60).rounded(.up)) * 60)
	}
}

public struct TraceBreakdownRequest: Hashable, Sendable {
	public var aggregation: TraceBreakdownAggregation
	public var groupBy: TraceBreakdownGroup
	public var window: ResolvedTimeWindow
	public var serviceName: String?
	public var hasError: Bool?
	public var limit: Int

	public init(
		aggregation: TraceBreakdownAggregation,
		groupBy: TraceBreakdownGroup,
		window: ResolvedTimeWindow,
		serviceName: String? = nil,
		hasError: Bool? = nil,
		limit: Int = 5
	) {
		self.aggregation = aggregation
		self.groupBy = groupBy
		self.window = window
		self.serviceName = serviceName
		self.hasError = hasError
		self.limit = limit
	}
}

extension MapleClient {
	public func traceTimeseries(_ request: TraceTimeseriesRequest) async throws -> TraceTimeseriesResult {
		try await mapping {
			let output = try await client.queryTraceTimeseries(
				.init(
					body: .json(
						.init(
							aggregation: request.aggregation,
							bucketSeconds: request.resolvedBucketSeconds,
							endTime: request.window.endTime,
							filters: filters(serviceName: request.serviceName, hasError: request.hasError),
							startTime: request.window.startTime
						)
					)
				)
			)
			return try output.ok.body.json
		}
	}

	public func traceBreakdown(_ request: TraceBreakdownRequest) async throws -> TraceBreakdownResult {
		try await mapping {
			let output = try await client.queryTraceBreakdown(
				.init(
					body: .json(
						.init(
							aggregation: request.aggregation,
							endTime: request.window.endTime,
							filters: filters(serviceName: request.serviceName, hasError: request.hasError),
							groupBy: request.groupBy,
							limit: request.limit,
							startTime: request.window.startTime
						)
					)
				)
			)
			return try output.ok.body.json
		}
	}

	private func filters(serviceName: String?, hasError: Bool?) -> Components.Schemas.TraceFilters? {
		guard serviceName != nil || hasError != nil else { return nil }
		return .init(hasError: hasError, serviceName: serviceName)
	}
}

extension TraceTimeseriesResult {
	/// The values of the first (only, when ungrouped) series, in order.
	public var values: [Double] {
		series.first?.points.map(\.value) ?? []
	}
}
