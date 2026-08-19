import MapleAPI
import MapleWidgetData
import SwiftUI

/// Every push destination in the app.
///
/// One enum, registered once per `NavigationStack` via `mapleDestinations()`,
/// so a service row on Home, an incident's service link, and the Services tab
/// all resolve the same way — and adding a screen is one case, not a hunt
/// through every stack for a missing `navigationDestination`.
enum Route: Hashable {
	case service(name: String, window: TimeWindow = .default)
	case issue(id: String)
	case incident(id: String)
	case anomaly(id: String)
	/// The Alerts tab, opened on a specific segment. Handled by the tab
	/// switcher rather than by push — see `AppNavigation`.
	case alerts(AlertsSegment)
}

enum AlertsSegment: String, CaseIterable, Identifiable, Hashable {
	case incidents
	case errors
	case anomalies

	var id: String { rawValue }

	var title: String {
		switch self {
		case .incidents: "Incidents"
		case .errors: "Errors"
		case .anomalies: "Anomalies"
		}
	}
}

extension View {
	func mapleDestinations() -> some View {
		navigationDestination(for: Route.self) { route in
			switch route {
			case .service(let name, let window):
				ServiceDetailView(serviceName: name, window: window)
			case .issue(let id):
				IssueDetailView(issueID: id)
			case .incident(let id):
				IncidentDetailView(incidentID: id)
			case .anomaly(let id):
				AnomalyDetailView(anomalyID: id)
			case .alerts:
				// Cross-tab: Home asks the tab bar to switch. Rendering it inline
				// would nest a hub inside a stack.
				EmptyView()
			}
		}
	}
}

/// Cross-tab navigation state. Home's "3 new issues" row switches to the Alerts
/// tab on the Errors segment; that's a tab change plus a segment change, which
/// no `NavigationStack` can express, so it lives here.
@MainActor
@Observable
final class AppNavigation {
	var tab: AppTab = .home
	var alertsSegment: AlertsSegment = .incidents
	/// The Alerts tab's stack. Owned here so a notification tap can push an
	/// incident onto it from outside the view tree.
	var alertsPath: [Route] = []
	/// The Services tab's stack, owned here for the same reason: the
	/// throughput widget opens the service it was configured for.
	var servicesPath: [Route] = []

	func open(_ segment: AlertsSegment) {
		alertsSegment = segment
		tab = .alerts
	}

	/// A tapped push: land on the incident, with the Alerts list underneath
	/// so back goes somewhere sensible.
	func openIncident(id: String) {
		alertsSegment = .incidents
		alertsPath = [.incident(id: id)]
		tab = .alerts
	}

	/// A tapped throughput widget: the service, with the Services list
	/// underneath so back goes somewhere sensible.
	func openService(name: String) {
		servicesPath = [.service(name: name)]
		tab = .services
	}

	/// A tapped widget row: the issue, with the Errors list underneath.
	func openIssue(id: String) {
		alertsSegment = .errors
		alertsPath = [.issue(id: id)]
		tab = .alerts
	}

	/// The Home Screen widget's deep links — `maple://issues` and
	/// `maple://issue/<id>`; see `IssuesWidgetKind`.
	///
	/// Anything else is ignored rather than guessed at: a URL this app does not
	/// recognise landing the user on a random tab is worse than it doing
	/// nothing, and the scheme is ours alone.
	func open(_ url: URL) {
		guard url.scheme == IssuesWidgetKind.urlScheme else { return }
		switch url.host() {
		case "incident":
			// `maple://incident/<id>` — a tapped Live Activity. The id is the
			// public `inc_…` form the activity was started with.
			let id = url.pathComponents.first { $0 != "/" }
			if let id, !id.isEmpty { openIncident(id: id) } else { open(.incidents) }
		case "issues":
			open(.errors)
		case "issue":
			// `maple://issue/<id>` — the id is the first path component, and an
			// empty one means the widget's row lost its issue.
			let id = url.pathComponents.first { $0 != "/" }
			if let id, !id.isEmpty { openIssue(id: id) } else { open(.errors) }
		case "services":
			servicesPath = []
			tab = .services
		case "service":
			// `maple://service/<name>`; service names can contain characters
			// the widget percent-encoded, so decode before matching.
			let name = url.pathComponents.first { $0 != "/" }?.removingPercentEncoding
			if let name, !name.isEmpty {
				openService(name: name)
			} else {
				servicesPath = []
				tab = .services
			}
		default:
			break
		}
	}
}

enum AppTab: Hashable {
	case home
	case services
	case alerts
}
