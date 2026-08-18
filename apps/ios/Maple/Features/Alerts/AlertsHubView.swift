import MapleAPI
import SwiftUI

/// The triage hub: incidents, error issues, and anomalies under one tab with a
/// segmented switch. Each segment owns its data and its toolbar; the hub owns
/// the stack and the segment.
struct AlertsHubView: View {
	@Environment(AppNavigation.self) private var navigation

	var body: some View {
		@Bindable var navigation = navigation
		NavigationStack(path: $navigation.alertsPath) {
			ZStack {
				Token.background.ignoresSafeArea()
				VStack(spacing: 0) {
					SegmentedControl(selection: $navigation.alertsSegment)
						.padding(.horizontal, 16)
						.padding(.top, 8)
						.padding(.bottom, 10)
					Hairline()
					switch navigation.alertsSegment {
					case .incidents: IncidentsListView()
					case .errors: IssuesListContent()
					case .anomalies: AnomaliesListView()
					}
				}
			}
			.navigationTitle("Alerts")
			.navigationBarTitleDisplayMode(.large)
			.toolbar {
				ToolbarItem(placement: .topBarLeading) {
					OrganizationSwitcherButton()
				}
			}
			.mapleDestinations()
		}
	}
}

/// Maple's segmented toggle: hairline frame, the active segment lifted one
/// tonal step. No system `Picker` — its capsule and its font would be the
/// only two non-Maple pixels on the screen.
struct SegmentedControl: View {
	@Binding var selection: AlertsSegment
	@Namespace private var namespace

	var body: some View {
		HStack(spacing: 2) {
			ForEach(AlertsSegment.allCases) { segment in
				Button {
					withAnimation(.snappy(duration: 0.22)) { selection = segment }
				} label: {
					Text(segment.title)
						.font(Typo.smallMedium)
						.foregroundStyle(selection == segment ? Token.foreground : Token.mutedForeground)
						.frame(maxWidth: .infinity)
						.frame(height: 28)
						.background {
							if selection == segment {
								RoundedRectangle(cornerRadius: Token.Radius.sm)
									.fill(Token.muted)
									.matchedGeometryEffect(id: "segment", in: namespace)
							}
						}
						.contentShape(.rect)
				}
				.buttonStyle(.plain)
			}
		}
		.padding(2)
		.background(Token.card, in: .rect(cornerRadius: Token.Radius.md))
		.overlay(
			RoundedRectangle(cornerRadius: Token.Radius.md)
				.stroke(Token.border, lineWidth: Token.hairline)
		)
	}
}
