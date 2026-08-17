import MapleAPI
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

	func open(_ segment: AlertsSegment) {
		alertsSegment = segment
		tab = .alerts
	}
}

enum AppTab: Hashable {
	case home
	case services
	case alerts
}
