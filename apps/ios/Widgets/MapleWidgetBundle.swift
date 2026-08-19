import SwiftUI
import WidgetKit

/// The extension's entry point. One widget today; the bundle exists so adding
/// a second (services, alert incidents) is a line rather than a restructure.
@main
struct MapleWidgetBundle: WidgetBundle {
	var body: some Widget {
		IssuesWidget()
	}
}
