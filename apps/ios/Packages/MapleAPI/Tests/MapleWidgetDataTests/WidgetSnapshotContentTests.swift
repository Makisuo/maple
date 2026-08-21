import Foundation
import Testing

@testable import MapleWidgetData

private let now = Date(timeIntervalSince1970: 1_800_000_000)

private func issue(
	id: String = "iss_1",
	title: String = "TypeError",
	subtitle: String? = "undefined is not a function",
	service: String = "api",
	severity: WidgetIssueSeverity? = .critical,
	count: Double = 41_210,
	lastSeen: Date = now.addingTimeInterval(-600),
	regressed: Bool = false,
	paging: Bool = false
) -> WidgetIssue {
	WidgetIssue(
		id: id,
		title: title,
		subtitle: subtitle,
		serviceName: service,
		severity: severity,
		occurrenceCount: count,
		lastSeenAt: lastSeen,
		isRegressed: regressed,
		hasOpenIncident: paging
	)
}

private func issues(_ rows: [WidgetIssue], at generatedAt: Date = now) -> IssuesSnapshot {
	IssuesSnapshot.make(
		organizationId: "org_1",
		organizationName: "Maple",
		generatedAt: generatedAt,
		issues: rows
	)
}

private func service(
	_ name: String?,
	throughput: Double,
	errorRate: Double = 0,
	p95: Double = 100,
	points: [Double] = [1, 2, 3, 4]
) -> ServiceThroughput {
	ServiceThroughput(
		name: name,
		throughputPerSecond: throughput,
		errorRate: errorRate,
		p95LatencyMs: p95,
		points: points
	)
}

private func throughput(_ rows: [ServiceThroughput], at generatedAt: Date = now) -> ThroughputSnapshot {
	ThroughputSnapshot.make(
		organizationId: "org_1",
		generatedAt: generatedAt,
		windowMinutes: 60,
		services: rows
	)
}

@Suite("Issues content fingerprint")
struct IssuesContentFingerprintTests {
	@Test("Ignores when the snapshot was fetched")
	func ignoresGeneratedAt() {
		#expect(
			issues([issue()]).contentFingerprint
				== issues([issue()], at: now.addingTimeInterval(3600)).contentFingerprint
		)
	}

	/// The reason plain `Equatable` is unusable here: on any live organization
	/// `lastSeenAt` moves every fetch, and a row still reading "10m" is not a
	/// reason to spend a reload.
	@Test("Ignores lastSeenAt moving inside the same rendered minute")
	func ignoresSubMinuteRecency() {
		let base = issue(lastSeen: Date(timeIntervalSince1970: 1_799_999_400))
		let moved = issue(lastSeen: Date(timeIntervalSince1970: 1_799_999_440))
		#expect(issues([base]).contentFingerprint == issues([moved]).contentFingerprint)
	}

	@Test("Notices lastSeenAt crossing a minute")
	func noticesMinuteBoundary() {
		let base = issue(lastSeen: Date(timeIntervalSince1970: 1_799_999_400))
		let moved = issue(lastSeen: Date(timeIntervalSince1970: 1_799_999_460))
		#expect(issues([base]).contentFingerprint != issues([moved]).contentFingerprint)
	}

	@Test("Ignores an occurrence count that still abbreviates the same")
	func ignoresSubDisplayCount() {
		#expect(
			issues([issue(count: 41_210)]).contentFingerprint
				== issues([issue(count: 41_240)]).contentFingerprint
		)
	}

	@Test("Notices an occurrence count that renders differently")
	func noticesRenderedCount() {
		#expect(
			issues([issue(count: 41_210)]).contentFingerprint
				!= issues([issue(count: 41_900)]).contentFingerprint
		)
	}

	@Test(
		"Notices anything the widget draws",
		arguments: [
			issue(title: "RangeError"),
			issue(subtitle: nil),
			issue(service: "web"),
			issue(severity: .high),
			issue(severity: nil),
			issue(regressed: true),
			issue(paging: true),
			issue(id: "iss_2"),
		]
	)
	func noticesRenderedFields(_ changed: WidgetIssue) {
		#expect(issues([issue()]).contentFingerprint != issues([changed]).contentFingerprint)
	}

	@Test("Notices the headline count and the 20+ cap")
	func noticesHeadline() {
		let one = issues([issue()])
		let two = issues([issue(), issue(id: "iss_2", severity: .high)])
		#expect(one.contentFingerprint != two.contentFingerprint)

		var capped = one
		capped.isCapped = true
		#expect(one.contentFingerprint != capped.contentFingerprint)
	}

	@Test("Notices the organization name shown in the header")
	func noticesOrganizationName() {
		var renamed = issues([issue()])
		renamed.organizationName = "Maple Inc"
		#expect(issues([issue()]).contentFingerprint != renamed.contentFingerprint)
	}

	/// `make`'s ordering is load-bearing for suppression: two builds of the same
	/// unordered input must fingerprint identically, or every round looks changed.
	@Test("Is stable across the input order")
	func stableAcrossInputOrder() {
		let rows = [
			issue(id: "a", severity: .high),
			issue(id: "b", severity: .critical),
			issue(id: "c", severity: .low),
		]
		#expect(issues(rows).contentFingerprint == issues(rows.reversed()).contentFingerprint)
	}
}

@Suite("Throughput content fingerprint")
struct ThroughputContentFingerprintTests {
	/// The whole reason this surface needs a rendered projection: `points` is a
	/// sliding window, so every bucket shifts on every fetch.
	/// Steady traffic, one bucket on: every value differs, the picture does not.
	/// A scroll big enough to move the rendered trend is a different matter and
	/// does earn a reload — see `noticesTrend`.
	@Test("Ignores the sparkline scrolling")
	func ignoresSparklineScroll() {
		let before = throughput([service("api", throughput: 12.5, points: [10, 11, 10, 11])])
		let after = throughput([service("api", throughput: 12.5, points: [11, 10, 11, 10])])
		#expect(before.contentFingerprint == after.contentFingerprint)
	}

	@Test("Ignores a rate that still renders the same")
	func ignoresSubDisplayRate() {
		#expect(
			throughput([service("api", throughput: 12.51)]).contentFingerprint
				== throughput([service("api", throughput: 12.54)]).contentFingerprint
		)
	}

	@Test("Notices a rate crossing a rounding boundary")
	func noticesRenderedRate() {
		#expect(
			throughput([service("api", throughput: 12.5)]).contentFingerprint
				!= throughput([service("api", throughput: 13.1)]).contentFingerprint
		)
	}

	@Test("Ignores an error rate that still renders the same")
	func ignoresSubDisplayErrorRate() {
		#expect(
			throughput([service("api", throughput: 10, errorRate: 0.010_41)]).contentFingerprint
				== throughput([service("api", throughput: 10, errorRate: 0.010_44)]).contentFingerprint
		)
	}

	@Test("Notices an error rate the reader would see change")
	func noticesRenderedErrorRate() {
		#expect(
			throughput([service("api", throughput: 10, errorRate: 0.01)]).contentFingerprint
				!= throughput([service("api", throughput: 10, errorRate: 0.09)]).contentFingerprint
		)
	}

	@Test("Notices p95 the reader would see change")
	func noticesLatency() {
		#expect(
			throughput([service("api", throughput: 10, p95: 100)]).contentFingerprint
				!= throughput([service("api", throughput: 10, p95: 480)]).contentFingerprint
		)
	}

	/// Trend is derived from `points`, so a change of shape that actually means
	/// something still earns a reload even though the buckets are excluded.
	@Test("Notices the trend flipping")
	func noticesTrend() {
		let rising = throughput([service("api", throughput: 10, points: [1, 1, 8, 8])])
		let falling = throughput([service("api", throughput: 10, points: [8, 8, 1, 1])])
		#expect(rising.contentFingerprint != falling.contentFingerprint)
	}

	@Test("Notices a service appearing or leaving the list")
	func noticesServiceSet() {
		let one = throughput([service("api", throughput: 10)])
		let two = throughput([service("api", throughput: 10), service("web", throughput: 4)])
		#expect(one.contentFingerprint != two.contentFingerprint)
	}

	@Test("Notices the window changing")
	func noticesWindow() {
		var hour = throughput([service("api", throughput: 10)])
		hour.windowMinutes = 15
		#expect(throughput([service("api", throughput: 10)]).contentFingerprint != hour.contentFingerprint)
	}
}

@Suite("Reload decision")
struct WidgetReloadDecisionTests {
	@Test("Reloads when nothing is on screen yet")
	func firstPublish() {
		#expect(
			WidgetReloadDecision.shouldReload(
				stored: nil,
				incoming: issues([issue()]),
				storedIsStale: false
			)
		)
	}

	/// The point of the whole mechanism: an unchanged round costs no reload.
	@Test("Stays put when nothing a reader could see changed")
	func suppressesUnchanged() {
		#expect(
			!WidgetReloadDecision.shouldReload(
				stored: issues([issue()]),
				incoming: issues([issue()], at: now.addingTimeInterval(120)),
				storedIsStale: false
			)
		)
	}

	/// Suppressing means the widget keeps rendering the *old* `generatedAt`, so
	/// identical-but-stale still reloads — otherwise it stays dimmed and
	/// captioned "updated 2h ago" while the numbers are actually current.
	@Test("Reloads identical content when what is on screen had gone stale")
	func reloadsToUndim() {
		#expect(
			WidgetReloadDecision.shouldReload(
				stored: issues([issue()]),
				incoming: issues([issue()], at: now.addingTimeInterval(7200)),
				storedIsStale: true
			)
		)
	}

	@Test("Reloads when the content changed")
	func reloadsChanged() {
		#expect(
			WidgetReloadDecision.shouldReload(
				stored: issues([issue()]),
				incoming: issues([issue(severity: .low)]),
				storedIsStale: false
			)
		)
	}
}

@Suite("Timeline schedule")
struct WidgetTimelineScheduleTests {
	@Test("Offsets start at zero and only move forward")
	func monotonic() {
		let offsets = WidgetTimelineSchedule.offsetMinutes
		#expect(offsets.first == 0)
		#expect(zip(offsets, offsets.dropFirst()).allSatisfy { $0 < $1 })
	}

	@Test("Entries are the offsets, applied to the build time")
	func entryDates() {
		let dates = WidgetTimelineSchedule.entryDates(from: now)
		#expect(dates.count == WidgetTimelineSchedule.offsetMinutes.count)
		for (date, minutes) in zip(dates, WidgetTimelineSchedule.offsetMinutes) {
			#expect(date == now.addingTimeInterval(Double(minutes) * 60))
		}
	}

	/// Entries past the refresh date are what let a throttled widget keep
	/// saying an honest "90m" instead of freezing on the last one it has.
	@Test("Some entries outlive the refresh request")
	func tailOutlivesRefresh() {
		let refresh = WidgetTimelineSchedule.refreshDate(from: now)
		#expect(refresh == now.addingTimeInterval(WidgetTimelineSchedule.refreshAfter))
		#expect(WidgetTimelineSchedule.entryDates(from: now).contains { $0 > refresh })
	}
}

@Suite("Updated footer copy")
struct WidgetUpdatedCopyTests {
	@Test(
		"Reads as a sentence at every scale",
		arguments: [
			(TimeInterval(0), "updated just now"),
			(TimeInterval(59), "updated just now"),
			(TimeInterval(12 * 60), "updated 12m ago"),
			(TimeInterval(3 * 3600), "updated 3h ago"),
			(TimeInterval(2 * 86_400), "updated 2d ago"),
		]
	)
	func copy(_ interval: TimeInterval, _ expected: String) {
		#expect(WidgetTime.updated(interval) == expected)
	}
}
