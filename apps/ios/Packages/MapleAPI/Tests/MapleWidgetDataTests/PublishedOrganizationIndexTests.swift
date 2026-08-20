import Foundation
import Testing

@testable import MapleWidgetData

@Suite("Published organizations")
struct PublishedOrganizationIndexTests {
	/// A suite **per test**, not per type: swift-testing runs these in parallel
	/// and `UserDefaults` is process-wide, so a shared name means one test wiping
	/// another's writes mid-assertion.
	private func makeIndex(_ name: String = #function) -> PublishedOrganizationIndex {
		let suiteName = "com.maple.tests.organizations.\(name)"
		UserDefaults(suiteName: suiteName)?.removePersistentDomain(forName: suiteName)
		return PublishedOrganizationIndex(appGroupIdentifier: suiteName)
	}

	private func organization(_ id: String, name: String? = nil, minutesAgo: Double = 0) -> PublishedOrganization {
		PublishedOrganization(
			id: id,
			name: name,
			lastPublishedAt: Date(timeIntervalSince1970: 1_800_000_000 - minutesAgo * 60)
		)
	}

	@Test("Reads nothing before the app has ever published")
	func startsEmpty() {
		let index = makeIndex()
		#expect(index.load().isEmpty)
		#expect(index.activeOrganizationId == nil)
	}

	@Test("The active organization sorts first, then the most recently published")
	func ordersActiveFirst() {
		let index = makeIndex()
		index.record(organization("org_a", name: "Acme", minutesAgo: 30), isActive: false)
		index.record(organization("org_b", name: "Globex", minutesAgo: 5), isActive: true)
		index.record(organization("org_c", name: "Initech", minutesAgo: 1), isActive: false)

		#expect(index.load().map(\.id) == ["org_b", "org_c", "org_a"])
		#expect(index.activeOrganizationId == "org_b")
	}

	@Test("Republishing replaces rather than duplicates")
	func recordReplaces() {
		let index = makeIndex()
		index.record(organization("org_a", name: "Acme", minutesAgo: 30), isActive: true)
		index.record(organization("org_a", name: "Acme Renamed", minutesAgo: 0), isActive: true)

		#expect(index.load().count == 1)
		#expect(index.load().first?.name == "Acme Renamed")
	}

	/// The "removed from the organization" case: the caller uses these ids to
	/// wipe the matching snapshots, so returning the wrong set leaves another
	/// account's data on the Home Screen.
	@Test("Pruning returns exactly the evicted ids and forgets a dropped active")
	func pruneEvicts() {
		let index = makeIndex()
		index.record(organization("org_a"), isActive: true)
		index.record(organization("org_b"), isActive: false)
		index.record(organization("org_c"), isActive: false)

		#expect(index.prune(to: ["org_b", "org_c"]) == ["org_a"])
		#expect(index.load().map(\.id).sorted() == ["org_b", "org_c"])
		#expect(index.activeOrganizationId == nil)
	}

	@Test("Pruning to the same membership set changes nothing")
	func pruneIsANoOpWhenNothingChanged() {
		let index = makeIndex()
		index.record(organization("org_a"), isActive: true)

		#expect(index.prune(to: ["org_a"]).isEmpty)
		#expect(index.activeOrganizationId == "org_a")
	}

	@Test("Signing out reports every id so their snapshots can go too")
	func clearReportsEveryId() {
		let index = makeIndex()
		index.record(organization("org_a"), isActive: true)
		index.record(organization("org_b"), isActive: false)

		#expect(index.clear().sorted() == ["org_a", "org_b"])
		#expect(index.load().isEmpty)
		#expect(index.activeOrganizationId == nil)
	}
}

@Suite("Per-organization snapshot storage")
struct PerOrganizationSnapshotStoreTests {
	/// Per test, for the same reason as above.
	private func suiteName(_ name: String = #function) -> String {
		let suiteName = "com.maple.tests.perOrgSnapshots.\(name)"
		UserDefaults(suiteName: suiteName)?.removePersistentDomain(forName: suiteName)
		return suiteName
	}

	private func snapshot(organizationId: String) -> IssuesSnapshot {
		IssuesSnapshot.make(
			organizationId: organizationId,
			organizationName: nil,
			generatedAt: Date(timeIntervalSince1970: 1_800_000_000),
			issues: [],
			hasMore: false
		)
	}

	/// The property the whole per-widget picker rests on: two organizations
	/// never read each other's numbers.
	@Test("Organizations keep separate keys")
	func organizationsAreIsolated() {
		let suite = suiteName()
		let acme = WidgetSnapshotStore<IssuesSnapshot>.issues(
			organizationId: "org_a",
			appGroupIdentifier: suite
		)
		let globex = WidgetSnapshotStore<IssuesSnapshot>.issues(
			organizationId: "org_b",
			appGroupIdentifier: suite
		)

		acme.save(snapshot(organizationId: "org_a"))

		#expect(acme.load()?.organizationId == "org_a")
		#expect(globex.load() == nil)

		acme.clear()
		globex.save(snapshot(organizationId: "org_b"))
		#expect(acme.load() == nil)
		#expect(globex.load()?.organizationId == "org_b")
	}

	@Test("Issues and throughput keep separate keys within one organization")
	func surfacesAreIsolated() {
		let suite = suiteName()
		let issues = WidgetSnapshotStore<IssuesSnapshot>.issues(
			organizationId: "org_a",
			appGroupIdentifier: suite
		)
		let throughput = WidgetSnapshotStore<ThroughputSnapshot>.throughput(
			organizationId: "org_a",
			appGroupIdentifier: suite
		)

		issues.save(snapshot(organizationId: "org_a"))
		#expect(throughput.load() == nil)
	}
}
