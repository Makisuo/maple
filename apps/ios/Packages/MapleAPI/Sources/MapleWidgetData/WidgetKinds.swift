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
	/// the Errors list. Handled by `AppNavigation.open(_:)`.
	public static let urlScheme = "maple"

	public static func issueURL(id: String) -> URL? {
		URL(string: "\(urlScheme)://issue/\(id)")
	}

	public static var issuesListURL: URL? {
		URL(string: "\(urlScheme)://issues")
	}
}

/// The throughput widget — configurable, per `SelectServiceIntent`, to one
/// service or to the whole organization.
public enum ThroughputWidgetKind {
	public static let identifier = "MapleThroughputWidget"

	/// A configured widget opens its service; the unconfigured one opens the
	/// Services tab.
	public static func serviceURL(name: String?) -> URL? {
		guard let name, !name.isEmpty else { return servicesListURL }
		guard let encoded = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else {
			return servicesListURL
		}
		return URL(string: "\(IssuesWidgetKind.urlScheme)://service/\(encoded)")
	}

	public static var servicesListURL: URL? {
		URL(string: "\(IssuesWidgetKind.urlScheme)://services")
	}
}
