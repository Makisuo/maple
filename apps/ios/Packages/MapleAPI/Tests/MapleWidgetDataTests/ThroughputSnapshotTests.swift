import Foundation
import Testing

@testable import MapleWidgetData

private let now = Date(timeIntervalSince1970: 1_800_000_000)

private func service(
	_ name: String,
	throughput: Double,
	errorRate: Double = 0,
	p95: Double = 100,
	points: [Double] = []
) -> ServiceThroughput {
	ServiceThroughput(
		name: name,
		throughputPerSecond: throughput,
		errorRate: errorRate,
		p95LatencyMs: p95,
		points: points
	)
}

@Suite("Throughput snapshot")
struct ThroughputSnapshotTests {
	@Test("Ranks services busiest first and caps the picker")
	func ranking() {
		let many = (0..<20).map { service("svc-\($0)", throughput: Double($0)) }
		let snapshot = ThroughputSnapshot.make(
			organizationId: "org_1",
			generatedAt: now,
			windowMinutes: 60,
			services: many
		)

		#expect(snapshot.services.first?.name == "svc-19")
		#expect(snapshot.services.count == ThroughputSnapshot.maximumServices)
	}

	/// The headline number and the rows come from one place, so a widget can
	/// never show a total that disagrees with the services under it.
	@Test("Derives the org total from the same rows")
	func derivedTotal() {
		let snapshot = ThroughputSnapshot.make(
			organizationId: "org_1",
			generatedAt: now,
			windowMinutes: 60,
			services: [
				service("api", throughput: 30, errorRate: 0.10, p95: 400, points: [10, 20]),
				service("web", throughput: 70, errorRate: 0.00, p95: 900, points: [30, 40]),
			]
		)

		#expect(snapshot.overall.name == nil)
		#expect(snapshot.overall.throughputPerSecond == 100)
		// Weighted by throughput: 30/100 of the traffic failing at 10%.
		#expect(abs(snapshot.overall.errorRate - 0.03) < 1e-9)
		// Percentiles do not average — the worst one wins.
		#expect(snapshot.overall.p95LatencyMs == 900)
		// The sparkline sums bucket by bucket.
		#expect(snapshot.overall.points == [40, 60])
	}

	/// A quiet service failing all three of its requests must not make the
	/// organization look 50% broken.
	@Test("A silent failing service barely moves the org error rate")
	func weightedErrorRate() {
		let total = ServiceThroughput.total(of: [
			service("busy", throughput: 999, errorRate: 0),
			service("quiet", throughput: 1, errorRate: 1),
		])

		#expect(total.errorRate < 0.002)
	}

	@Test("Sums sparklines of unequal length without dropping a series")
	func ragged() {
		let total = ServiceThroughput.total(of: [
			service("a", throughput: 1, points: [1, 1, 1]),
			service("b", throughput: 1, points: [2]),
		])

		#expect(total.points == [3, 1, 1])
	}

	@Test("An empty org totals to zero rather than dividing by it")
	func emptyTotal() {
		let total = ServiceThroughput.total(of: [])
		#expect(total.throughputPerSecond == 0)
		#expect(total.errorRate == 0)
		#expect(total.points.isEmpty)
	}

	@Test("Looks up the configured service, and admits when it is gone")
	func lookup() {
		let snapshot = ThroughputSnapshot.make(
			organizationId: "org_1",
			generatedAt: now,
			windowMinutes: 60,
			services: [service("api", throughput: 5)]
		)

		#expect(snapshot.service(named: "api")?.name == "api")
		// nil asks for the organization total, not "anything".
		#expect(snapshot.service(named: nil)?.name == nil)
		// A service that stopped reporting is nil, never a silent fallback to
		// the total — that would read as "your service is fine".
		#expect(snapshot.service(named: "deleted-service") == nil)
	}
}

@Suite("Throughput trend")
struct ThroughputTrendTests {
	@Test("Compares the second half of the window with the first")
	func trend() throws {
		let doubled = service("api", throughput: 1, points: [10, 10, 20, 20]).trend
		#expect(abs(try #require(doubled) - 1.0) < 1e-9)

		let halved = service("api", throughput: 1, points: [20, 20, 10, 10]).trend
		#expect(abs(try #require(halved) + 0.5) < 1e-9)
	}

	@Test("Says nothing rather than something false")
	func undefinedTrend() {
		// Too little window to claim a direction.
		#expect(service("api", throughput: 1, points: [1, 2]).trend == nil)
		// Traffic arriving from silence is not a percentage.
		#expect(service("api", throughput: 1, points: [0, 0, 5, 5]).trend == nil)
	}
}

@Suite("Throughput snapshot store", .serialized)
struct ThroughputSnapshotStoreTests {
	private static let suiteName = "com.maple.tests.throughput-snapshot"

	private func makeStore() -> WidgetSnapshotStore<ThroughputSnapshot> {
		UserDefaults(suiteName: Self.suiteName)?.removePersistentDomain(forName: Self.suiteName)
		return WidgetSnapshotStore(key: "throughput.snapshot.v1", appGroupIdentifier: Self.suiteName)
	}

	@Test("Round-trips through the shared suite")
	func roundTrip() {
		let store = makeStore()
		let snapshot = ThroughputSnapshot.make(
			organizationId: "org_1",
			generatedAt: now,
			windowMinutes: 60,
			services: [service("api", throughput: 12.5, errorRate: 0.01, p95: 143, points: [1, 2, 3])]
		)

		#expect(store.save(snapshot))
		#expect(store.load() == snapshot)
	}

	/// The two snapshots share a suite; clearing one must not take the other
	/// with it, and neither may read the other's bytes.
	@Test("Issues and throughput keep separate keys")
	func separateKeys() {
		UserDefaults(suiteName: Self.suiteName)?.removePersistentDomain(forName: Self.suiteName)
		let issues = WidgetSnapshotStore<IssuesSnapshot>(key: "issues.snapshot.v1", appGroupIdentifier: Self.suiteName)
		let throughput = WidgetSnapshotStore<ThroughputSnapshot>(
			key: "throughput.snapshot.v1",
			appGroupIdentifier: Self.suiteName
		)

		issues.save(IssuesSnapshot.empty(organizationId: "org_1", generatedAt: now))
		throughput.save(
			ThroughputSnapshot.make(organizationId: "org_1", generatedAt: now, windowMinutes: 60, services: [])
		)

		throughput.clear()
		#expect(throughput.load() == nil)
		#expect(issues.load() != nil)
	}
}

@Suite("Throughput formatting")
struct WidgetFormatTests {
	@Test("Rates read like the Services tab")
	func rates() {
		#expect(WidgetFormat.rate(0) == "0/s")
		#expect(WidgetFormat.rate(12.53) == "12.5/s")
		#expect(WidgetFormat.rate(2400) == "2.4k/s")
		// A rare-but-alive service must not render as silence.
		#expect(WidgetFormat.rate(0.004) == "0.004/s")
	}

	@Test("A tiny error rate is not rounded away to zero")
	func errorRates() {
		#expect(WidgetFormat.errorRate(0) == "0%")
		#expect(WidgetFormat.errorRate(0.00002) == "<0.01%")
		#expect(WidgetFormat.errorRate(0.0042) == "0.42%")
		#expect(WidgetFormat.errorRate(0.5) == "50%")
	}

	@Test("Wobble is called steady rather than dressed up as a trend")
	func trends() {
		#expect(WidgetFormat.trend(0.03) == "steady")
		#expect(WidgetFormat.trend(0.21) == "+21%")
		#expect(WidgetFormat.trend(-0.08) == "-8%")
		#expect(WidgetFormat.trend(nil) == nil)
	}
}
