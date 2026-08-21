import SwiftUI
import WidgetKit

/// The extension's entry point.
///
/// Every widget the extension offers has to be listed here — a widget that
/// compiles but is missing from this body simply never appears in the gallery,
/// with no error anywhere.
@main
struct MapleWidgetBundle: WidgetBundle {
	var body: some Widget {
		IssuesWidget()
		ThroughputWidget()
		// A Live Activity is declared here like any other widget; it just never
		// appears in the gallery, because only a running activity can show it.
		IncidentActivityWidget()
	}
}
