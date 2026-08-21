import Foundation

/// The identifiers the app and the widget extension have to agree on letter for
/// letter, in the one module both of them link.
///
/// `kind` is how `WidgetCenter.reloadTimelines(ofKind:)` in the app addresses
/// the `Widget` declared in the extension. A mismatch does not fail to build
/// and does not log — the Home Screen simply stops updating until iOS decides
/// to refresh it on its own schedule.
public enum IssuesWidgetKind {
	public static let identifier = "MapleIssuesWidget"

	/// Tapping a row opens the app on that issue; tapping anything else opens
	/// the Errors list. Built and parsed by `WidgetDeepLink`, routed by
	/// `DestinationOpener`.
	public static let urlScheme = WidgetDeepLink.scheme

	/// `organizationId` is required rather than defaulted: a widget pinned to one
	/// organization that emits an organization-less link sends the tap to
	/// whichever org happens to be active, which is the bug these links exist to
	/// avoid. A compile error at the call site is the point.
	public static func issueURL(id: String, organizationId: String?) -> URL? {
		WidgetDeepLink(target: .issue(id: id), organizationId: organizationId).url
	}

	public static func issuesListURL(organizationId: String?) -> URL? {
		WidgetDeepLink(target: .issuesList, organizationId: organizationId).url
	}
}

/// The throughput widget — configurable, per `SelectServiceIntent`, to one
/// service or to the whole organization.
public enum ThroughputWidgetKind {
	public static let identifier = "MapleThroughputWidget"

	/// A configured widget opens its service; the unconfigured one opens the
	/// Services tab.
	public static func serviceURL(name: String?, organizationId: String?) -> URL? {
		guard let name, !name.isEmpty else { return servicesListURL(organizationId: organizationId) }
		return WidgetDeepLink(target: .service(name: name), organizationId: organizationId).url
	}

	public static func servicesListURL(organizationId: String?) -> URL? {
		WidgetDeepLink(target: .servicesList, organizationId: organizationId).url
	}
}
