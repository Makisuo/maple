import Foundation
import Testing

@testable import MapleWidgetData

private let now = Date(timeIntervalSince1970: 1_800_000_000)

private func issue(
	_ id: String,
	severity: WidgetIssueSeverity?,
	lastSeen: TimeInterval = 0,
	incident: Bool = false
) -> WidgetIssue {
	WidgetIssue(
		id: id,
		title: "TypeError",
		serviceName: "api",
		severity: severity,
		occurrenceCount: 1,
		lastSeenAt: now.addingTimeInterval(lastSeen),
		hasOpenIncident: incident
	)
}

@Suite("Issues snapshot")
struct IssuesSnapshotTests {
	@Test("Ranks by severity, then open incident, then recency")
	func ranking() {
		let snapshot = IssuesSnapshot.make(
			organizationId: "org_1",
			generatedAt: now,
			issues: [
				issue("low", severity: .low, lastSeen: -10),
				issue("critical-old", severity: .critical, lastSeen: -600),
				issue("high-paging", severity: .high, lastSeen: -900, incident: true),
				issue("high-recent", severity: .high, lastSeen: -30),
			]
		)

		#expect(snapshot.issues.map(\.id) == ["critical-old", "high-paging", "high-recent", "low"])
	}

	/// An untriaged issue has no severity. Sorting it as though it were
	/// critical would put unreviewed noise above the thing actually paging.
	@Test("An issue with no severity ranks below low")
	func unrankedSeverity() {
		let snapshot = IssuesSnapshot.make(
			organizationId: "org_1",
			generatedAt: now,
			issues: [issue("untriaged", severity: nil), issue("low", severity: .low)]
		)

		#expect(snapshot.issues.map(\.id) == ["low", "untriaged"])
	}

	@Test("Ties break on id so the same input always yields the same order")
	func stableOrder() {
		let issues = [issue("b", severity: .high), issue("a", severity: .high)]
		let first = IssuesSnapshot.make(organizationId: "org_1", generatedAt: now, issues: issues)
		let second = IssuesSnapshot.make(organizationId: "org_1", generatedAt: now, issues: issues.reversed())

		#expect(first.issues.map(\.id) == ["a", "b"])
		#expect(first.issues == second.issues)
	}

	/// The headline is the total, not the number of rows that fit — otherwise
	/// a widget showing six rows would always claim exactly six issues.
	@Test("Counts every issue but carries only the rows a widget can show")
	func countsBeforeTruncation() {
		let many = (0..<20).map { issue("issue-\($0)", severity: $0 < 3 ? .critical : .medium) }
		let snapshot = IssuesSnapshot.make(organizationId: "org_1", generatedAt: now, issues: many, hasMore: true)

		#expect(snapshot.openCount == 20)
		#expect(snapshot.criticalCount == 3)
		#expect(snapshot.issues.count == IssuesSnapshot.maximumIssues)
		#expect(snapshot.isCapped)
	}

	@Test("An org with nothing ongoing is empty, not missing")
	func emptySnapshot() {
		let snapshot = IssuesSnapshot.empty(organizationId: "org_1", generatedAt: now)
		#expect(snapshot.isEmpty)
		#expect(snapshot.issues.isEmpty)
		#expect(!snapshot.isCapped)
	}

	@Test("Goes stale after half an hour")
	func staleness() {
		let snapshot = IssuesSnapshot.empty(organizationId: "org_1", generatedAt: now)
		#expect(!snapshot.isStale(at: now.addingTimeInterval(29 * 60)))
		#expect(snapshot.isStale(at: now.addingTimeInterval(31 * 60)))
		// A clock that went backwards must not report a negative age.
		#expect(snapshot.age(at: now.addingTimeInterval(-500)) == 0)
	}
}

@Suite("Issues snapshot store", .serialized)
struct IssuesSnapshotStoreTests {
	/// A throwaway suite: the real App Group is shared with a widget that is
	/// running on the same machine as these tests.
	private static let suiteName = "com.maple.tests.issues-snapshot"

	private func makeStore() -> WidgetSnapshotStore<IssuesSnapshot> {
		UserDefaults(suiteName: Self.suiteName)?.removePersistentDomain(forName: Self.suiteName)
		return WidgetSnapshotStore(key: "issues.snapshot.v1", appGroupIdentifier: Self.suiteName)
	}

	@Test("Round-trips through the shared suite")
	func roundTrip() {
		let store = makeStore()
		let snapshot = IssuesSnapshot.make(
			organizationId: "org_1",
			organizationName: "Maple",
			generatedAt: now,
			issues: [issue("a", severity: .critical, incident: true)]
		)

		#expect(store.save(snapshot))
		#expect(store.load() == snapshot)
	}

	@Test("Reads nothing before the app has ever written")
	func emptyStore() {
		#expect(makeStore().load() == nil)
	}

	@Test("Clearing leaves nothing behind for the next account")
	func clearing() {
		let store = makeStore()
		store.save(IssuesSnapshot.empty(organizationId: "org_1", generatedAt: now))
		store.clear()
		#expect(store.load() == nil)
	}

	/// Dates cross the process boundary as ISO-8601 strings; a lossy encoding
	/// would make "12m" drift between the app and the widget.
	@Test("Preserves the timestamp exactly")
	func datesSurvive() {
		let store = makeStore()
		let generated = Date(timeIntervalSince1970: 1_800_000_123)
		store.save(IssuesSnapshot.empty(organizationId: "org_1", generatedAt: generated))
		#expect(store.load()?.generatedAt == generated)
	}
}

@Suite("Widget formatting")
struct WidgetTimeTests {
	@Test("Matches the app's terse last-seen scale")
	func lastSeen() {
		#expect(WidgetTime.lastSeen(now.addingTimeInterval(-30), now: now) == "now")
		#expect(WidgetTime.lastSeen(now.addingTimeInterval(-720), now: now) == "12m")
		#expect(WidgetTime.lastSeen(now.addingTimeInterval(-3 * 3600), now: now) == "3h")
		#expect(WidgetTime.lastSeen(now.addingTimeInterval(-5 * 86_400), now: now) == "5d")
	}

	@Test("Abbreviates counts the way the issue list does")
	func counts() {
		#expect(WidgetTime.count(942) == "942")
		#expect(WidgetTime.count(1200) == "1.2K")
		#expect(WidgetTime.count(2_000_000) == "2M")
	}

	@Test("Spells out the snapshot's age")
	func age() {
		#expect(WidgetTime.age(20) == "just now")
		#expect(WidgetTime.age(1800) == "30m ago")
		#expect(WidgetTime.age(7200) == "2h ago")
	}
}
