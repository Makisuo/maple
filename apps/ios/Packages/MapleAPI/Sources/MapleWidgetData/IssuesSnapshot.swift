import Foundation

/// What the Home Screen widget draws: the org's ongoing issues, reduced to the
/// handful of fields a 170×170pt canvas can actually show.
///
/// Deliberately its own module, with **no dependency on `MapleAPI`**. The
/// widget extension renders this and nothing else — it never holds a Clerk
/// session, never calls the v2 API, and so never has to solve "how does an
/// extension refresh a 60-second JWT". The app owns the network and writes the
/// result here; see `IssuesWidgetPublisher` in the app target.
///
/// Every field is a plain value: the snapshot crosses a process boundary as
/// JSON in the shared App Group, so a type that only the app can construct
/// would not survive the trip.
public struct IssuesSnapshot: Codable, Sendable, Equatable {
	/// Which org these issues belong to. The widget shows it when the account
	/// has more than one, so a switch in the app is visible on the Home Screen
	/// rather than silently changing what the numbers mean.
	public var organizationId: String
	public var organizationName: String?
	/// When the app last managed to fetch. The widget renders staleness from
	/// this rather than pretending a cached list is current.
	public var generatedAt: Date

	/// Ongoing issues — the ones the app's "Needs attention" filter returns.
	/// Capped by the page the app asked for; see `isCapped`.
	public var openCount: Int
	public var criticalCount: Int
	public var highCount: Int
	/// True when the org has more ongoing issues than the app fetched, so
	/// `openCount` is a floor and renders as "20+".
	public var isCapped: Bool

	/// The top rows, already ranked and truncated by `make`.
	public var issues: [WidgetIssue]

	public init(
		organizationId: String,
		organizationName: String?,
		generatedAt: Date,
		openCount: Int,
		criticalCount: Int,
		highCount: Int,
		isCapped: Bool,
		issues: [WidgetIssue]
	) {
		self.organizationId = organizationId
		self.organizationName = organizationName
		self.generatedAt = generatedAt
		self.openCount = openCount
		self.criticalCount = criticalCount
		self.highCount = highCount
		self.isCapped = isCapped
		self.issues = issues
	}

	/// The largest family shows six rows; nothing is served by carrying more
	/// across the boundary.
	public static let maximumIssues = 6

	/// Rank, truncate, and count in one place, so the app cannot write a
	/// snapshot whose headline number disagrees with its rows.
	///
	/// - Parameters:
	///   - issues: every ongoing issue the app fetched, in any order.
	///   - hasMore: the page's `has_more`, i.e. "there are others we didn't see".
	public static func make(
		organizationId: String,
		organizationName: String? = nil,
		generatedAt: Date,
		issues: [WidgetIssue],
		hasMore: Bool = false
	) -> IssuesSnapshot {
		IssuesSnapshot(
			organizationId: organizationId,
			organizationName: organizationName,
			generatedAt: generatedAt,
			openCount: issues.count,
			criticalCount: issues.count { $0.severity == .critical },
			highCount: issues.count { $0.severity == .high },
			isCapped: hasMore,
			issues: Array(issues.sorted(by: WidgetIssue.isMoreUrgent).prefix(maximumIssues))
		)
	}

	/// An org with nothing ongoing. Distinct from "no snapshot at all", which
	/// is what the widget shows before the app has ever run.
	public static func empty(organizationId: String, organizationName: String? = nil, generatedAt: Date) -> IssuesSnapshot {
		make(organizationId: organizationId, organizationName: organizationName, generatedAt: generatedAt, issues: [])
	}

	public var isEmpty: Bool { openCount == 0 }

	/// How old the snapshot is at `date`. The widget's timeline is driven by
	/// this: past `staleAfter` it dims and says so.
	public func age(at date: Date) -> TimeInterval { max(0, date.timeIntervalSince(generatedAt)) }

	/// Beyond half an hour the numbers stop being "right now". Background
	/// refresh is opportunistic — iOS grants it when it feels like it — so the
	/// honest thing is to keep showing the last known list and mark it.
	public static let staleAfter: TimeInterval = 30 * 60

	public func isStale(at date: Date) -> Bool { age(at: date) > Self.staleAfter }
}

/// One row. Mirrors `ErrorIssue` from the v2 contract, minus everything a
/// widget cannot render.
public struct WidgetIssue: Codable, Sendable, Equatable, Identifiable {
	public var id: String
	/// The exception type, or the label when the kind carries no type — the
	/// same fallback the app's `IssueRow` makes.
	public var title: String
	/// The exception message, already suppressed by the app when it would
	/// merely restate the title.
	public var subtitle: String?
	public var serviceName: String
	/// Optional because the contract's severity is optional: an untriaged
	/// issue has none, and inventing one would put it above real criticals.
	public var severity: WidgetIssueSeverity?
	public var occurrenceCount: Double
	public var lastSeenAt: Date
	/// Fixed, then seen again. Worth a mark: it is the state that means a
	/// deploy undid a fix.
	public var isRegressed: Bool
	/// The issue is currently paging someone.
	public var hasOpenIncident: Bool

	public init(
		id: String,
		title: String,
		subtitle: String? = nil,
		serviceName: String,
		severity: WidgetIssueSeverity?,
		occurrenceCount: Double,
		lastSeenAt: Date,
		isRegressed: Bool = false,
		hasOpenIncident: Bool = false
	) {
		self.id = id
		self.title = title
		self.subtitle = subtitle
		self.serviceName = serviceName
		self.severity = severity
		self.occurrenceCount = occurrenceCount
		self.lastSeenAt = lastSeenAt
		self.isRegressed = isRegressed
		self.hasOpenIncident = hasOpenIncident
	}

	/// Severity first, then whether it is actively paging, then recency.
	///
	/// Not the app's list order (which the user filters and sorts): a widget
	/// gets one glance and no controls, so the row that would make someone
	/// open the app has to be the first one.
	public static func isMoreUrgent(_ lhs: WidgetIssue, _ rhs: WidgetIssue) -> Bool {
		let left = lhs.severity?.rank ?? WidgetIssueSeverity.unrankedRank
		let right = rhs.severity?.rank ?? WidgetIssueSeverity.unrankedRank
		if left != right { return left > right }
		if lhs.hasOpenIncident != rhs.hasOpenIncident { return lhs.hasOpenIncident }
		if lhs.lastSeenAt != rhs.lastSeenAt { return lhs.lastSeenAt > rhs.lastSeenAt }
		// A total order: two issues seen in the same second must not sort
		// differently between two builds of the same snapshot.
		return lhs.id < rhs.id
	}
}

/// `IssueSeverity` from the contract, re-declared so this module stays free of
/// the generated client. The raw values match the wire values, so a future
/// severity the app does not know about decodes as `nil` rather than crashing
/// the widget.
public enum WidgetIssueSeverity: String, Codable, Sendable, CaseIterable {
	case critical
	case high
	case medium
	case low

	public var rank: Int {
		switch self {
		case .critical: 4
		case .high: 3
		case .medium: 2
		case .low: 1
		}
	}

	/// An issue with no severity ranks below `low`: it has not been triaged,
	/// which is not the same as being urgent.
	public static let unrankedRank = 0

	public var label: String {
		switch self {
		case .critical: "Critical"
		case .high: "High"
		case .medium: "Medium"
		case .low: "Low"
		}
	}
}
