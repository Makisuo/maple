import Foundation
import MapleWidgetData

/// Gallery and placeholder data — real-shaped, because someone deciding
/// whether to add this widget decides from what it looks like with traffic on
/// it, including a service that is failing.
extension ThroughputSnapshot {
	static var sample: ThroughputSnapshot {
		func wave(_ base: Double, ramp: Double = 0) -> [Double] {
			(0..<24).map { index in
				let progress = Double(index) / 23
				return base * (1 + sin(Double(index) * 0.8) * 0.08 + ramp * progress)
			}
		}

		return ThroughputSnapshot.make(
			organizationId: "org_sample",
			generatedAt: Date(),
			windowMinutes: 60,
			services: [
				ServiceThroughput(
					name: "maple-api",
					throughputPerSecond: 128.4,
					errorRate: 0.0042,
					p95LatencyMs: 143,
					points: wave(128, ramp: 0.35)
				),
				ServiceThroughput(
					name: "ingest",
					throughputPerSecond: 96.1,
					errorRate: 0.0002,
					p95LatencyMs: 38,
					points: wave(96)
				),
				ServiceThroughput(
					name: "checkout-api",
					throughputPerSecond: 24.7,
					errorRate: 0.061,
					p95LatencyMs: 2140,
					points: wave(25, ramp: -0.4)
				),
				ServiceThroughput(
					name: "query-engine",
					throughputPerSecond: 8.2,
					errorRate: 0,
					p95LatencyMs: 890,
					points: wave(8)
				),
				ServiceThroughput(
					name: "web",
					throughputPerSecond: 3.1,
					errorRate: 0.001,
					p95LatencyMs: 310,
					points: wave(3)
				),
			]
		)
	}
}
