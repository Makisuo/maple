import Foundation
import Testing

@testable import MapleWidgetData

@Suite("Widget organizations")
struct WidgetOrganizationIndexTests {
	/// A suite **per test**, not per type: swift-testing runs these in parallel
	/// and `UserDefaults` is process-wide, so a shared name means one test wiping
	/// another's writes mid-assertion.
	private func makeIndex(_ name: String = #function) -> WidgetOrganizationIndex {
		let suiteName = "com.maple.tests.organizations.\(name)"
		UserDefaults(suiteName: suiteName)?.removePersistentDomain(forName: suiteName)
		return WidgetOrganizationIndex(appGroupIdentifier: suiteName)
	}

	private func organization(_ id: String, name: String? = nil, minutesAgo: Double = 0) -> WidgetOrganization {
		WidgetOrganization(
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

	/// Alphabetical, not by publish recency: the picker reads this, and rows
	/// that reorder between two openings because a background round touched one
	/// of them are rows you cannot learn.
	@Test("The active organization sorts first, then alphabetically")
	func ordersActiveFirst() {
		let index = makeIndex()
		index.record(organization("org_a", name: "Initech", minutesAgo: 30), isActive: false)
		index.record(organization("org_b", name: "Globex", minutesAgo: 5), isActive: true)
		index.record(organization("org_c", name: "Acme", minutesAgo: 1), isActive: false)

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

	/// A headless round can know an id and no name. Writing the nil through
	/// would make the picker render a raw `org_…`.
	@Test("A nameless publish keeps the name already on file")
	func recordKeepsKnownName() {
		let index = makeIndex()
		index.record(memberships: [WidgetOrganization(id: "org_a", name: "Acme")])
		index.record(organization("org_a", name: nil), isActive: true)

		#expect(index.load().first?.name == "Acme")
	}

	/// The bug this whole index change exists for: an organization was listed
	/// only once it had been published, and only the active organization and
	/// ones already pinned to a widget get published — so it could not be
	/// picked until it had been picked.
	@Test("An organization with no snapshot is still offered by the picker")
	func membershipsAreListedBeforeAnythingIsPublished() {
		let index = makeIndex()
		index.record(memberships: [
			WidgetOrganization(id: "org_a", name: "Acme"),
			WidgetOrganization(id: "org_b", name: "Globex"),
		])

		#expect(index.load().map(\.id) == ["org_a", "org_b"])
		#expect(index.load().allSatisfy { $0.lastPublishedAt == nil })
	}

	@Test("Recording memberships keeps each organization's publish time")
	func membershipsPreservePublishTime() {
		let index = makeIndex()
		let publishedAt = Date(timeIntervalSince1970: 1_800_000_000)
		index.record(WidgetOrganization(id: "org_a", name: "Acme", lastPublishedAt: publishedAt), isActive: true)

		index.record(memberships: [
			WidgetOrganization(id: "org_a", name: "Acme"),
			WidgetOrganization(id: "org_b", name: "Globex"),
		])

		#expect(index.load().first { $0.id == "org_a" }?.lastPublishedAt == publishedAt)
		#expect(index.load().first { $0.id == "org_b" }?.lastPublishedAt == nil)
	}

	/// The caller spends a widget reload on `true`, and iOS meters those — so
	/// the launch that learns nothing has to say so.
	@Test("Recording memberships reports a change only when something changed")
	func membershipsReportChangeHonestly() {
		let index = makeIndex()
		let acme = [WidgetOrganization(id: "org_a", name: "Acme")]

		#expect(index.record(memberships: acme) == true)
		#expect(index.record(memberships: acme) == false)
		#expect(index.record(memberships: [WidgetOrganization(id: "org_a", name: "Acme Renamed")]) == true)
		#expect(index.record(memberships: acme + [WidgetOrganization(id: "org_b", name: "Globex")]) == true)
	}

	/// Removal belongs to `prune` alone, which has the snapshots to wipe with
	/// it. Dropping an entry here would strand one in the App Group.
	@Test("Recording memberships never removes")
	func membershipsDoNotRemove() {
		let index = makeIndex()
		index.record(memberships: [
			WidgetOrganization(id: "org_a", name: "Acme"),
			WidgetOrganization(id: "org_b", name: "Globex"),
		])
		index.record(memberships: [WidgetOrganization(id: "org_a", name: "Acme")])

		#expect(index.load().map(\.id).sorted() == ["org_a", "org_b"])
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

/// The rule that keeps a widget from putting one organization's name over
/// another's numbers. Lives here rather than in the app target, which has no
/// test bundle — the same reason `DestinationResolver` does.
@Suite("Resolving an organization's name")
struct WidgetOrganizationNameTests {
	private let memberships = [
		WidgetOrganization(id: "org_a", name: "Acme"),
		WidgetOrganization(id: "org_b", name: "Globex"),
	]

	@Test("The membership list wins")
	func prefersMemberships() {
		let name = WidgetOrganizationIndex.resolveName(
			id: "org_b",
			memberships: memberships,
			existing: [WidgetOrganization(id: "org_b", name: "Stale")]
		)
		#expect(name == "Globex")
	}

	/// A background launch has no membership list — only what is already on
	/// file. Falling through to nil there would blank every name in the picker.
	@Test("Falls back to what is already on file")
	func fallsBackToIndex() {
		let name = WidgetOrganizationIndex.resolveName(
			id: "org_b",
			memberships: [],
			existing: [WidgetOrganization(id: "org_b", name: "Globex")]
		)
		#expect(name == "Globex")
	}

	/// The actual bug: the id came from the session's active-organization claim
	/// and the name from a separate object that had not caught up, so
	/// organization B was recorded under organization A's name. Nothing here
	/// takes a name that is not keyed by the id being resolved.
	@Test("An unknown id gets no name, never a neighbour's")
	func neverBorrowsAnotherName() {
		let name = WidgetOrganizationIndex.resolveName(
			id: "org_c",
			memberships: memberships,
			existing: [WidgetOrganization(id: "org_a", name: "Acme")]
		)
		#expect(name == nil)
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
