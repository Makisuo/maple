import Foundation
import MapleWidgetData

/// What the widget gallery and the placement placeholder show.
///
/// Real-shaped rather than lorem: someone deciding whether to add this widget
/// is deciding from what it looks like with a critical issue on it.
extension IssuesSnapshot {
	static var sample: IssuesSnapshot {
		let now = Date()
		return IssuesSnapshot.make(
			organizationId: "org_sample",
			organizationName: "Maple",
			generatedAt: now,
			issues: [
				WidgetIssue(
					id: "iss_1",
					title: "TypeError",
					subtitle: "Cannot read properties of undefined",
					serviceName: "maple-api",
					severity: .critical,
					occurrenceCount: 1842,
					lastSeenAt: now.addingTimeInterval(-90),
					hasOpenIncident: true
				),
				WidgetIssue(
					id: "iss_2",
					title: "QueryTimeout",
					serviceName: "query-engine",
					severity: .high,
					occurrenceCount: 216,
					lastSeenAt: now.addingTimeInterval(-14 * 60),
					isRegressed: true
				),
				WidgetIssue(
					id: "iss_3",
					title: "ConnectTimeoutError",
					serviceName: "ingest",
					severity: .medium,
					occurrenceCount: 48,
					lastSeenAt: now.addingTimeInterval(-52 * 60)
				),
				WidgetIssue(
					id: "iss_4",
					title: "SchemaDecodeError",
					serviceName: "alerting",
					severity: .low,
					occurrenceCount: 12,
					lastSeenAt: now.addingTimeInterval(-3 * 3600)
				),
			],
			hasMore: true
		)
	}
}
