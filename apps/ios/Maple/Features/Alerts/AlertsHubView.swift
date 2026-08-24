import MapleAPI
import SwiftUI

/// The triage hub: incidents, error issues, and anomalies under one tab with a
/// segmented switch. Each segment owns its data and its toolbar; the hub owns
/// the stack and the segment.
struct AlertsHubView: View {
	@Environment(AppNavigation.self) private var navigation
	@Environment(SessionController.self) private var session
	@Environment(EnvironmentController.self) private var environments
	@State private var models: AlertsHubModels?

	private var scope: SessionController.DataScope {
		.init(generation: session.dataGeneration, environment: environments.selected)
	}

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
					if let models {
						switch navigation.alertsSegment {
						case .incidents: IncidentsListView(model: models.incidents)
						case .errors: IssuesListContent(model: models.issues)
						case .anomalies: AnomaliesListView(model: models.anomalies)
						}
					} else {
						// One frame, before the models exist: the same skeleton
						// the segment renders itself.
						ScrollView { SkeletonList(rowHeight: segmentRowHeight) }
					}
				}
			}
			.navigationTitle("Alerts")
			.navigationBarTitleDisplayMode(.large)
			.toolbar {
				ToolbarItem(placement: .topBarLeading) {
					OrganizationSwitcherButton()
				}
				ToolbarItem(placement: .topBarLeading) {
					EnvironmentPickerView()
				}
			}
			.mapleDestinations()
		}
		// Re-runs on an org switch or an environment change, replacing all three
		// models at once so no segment shows one scope's rows under the next
		// scope's title.
		.task(id: scope) {
			if models?.scope != scope {
				models = AlertsHubModels(session: session, scope: scope)
			}
		}
	}

	private var segmentRowHeight: CGFloat {
		switch navigation.alertsSegment {
		case .incidents: 72
		case .errors: 56
		case .anomalies: 64
		}
	}
}

/// The three segments' models, owned by the hub rather than by the segment
/// views. A segment view is rebuilt on every switch (it's a `switch` in the
/// hub's body), and when the model lived in the view as `@State` it went with
/// it — so Incidents → Errors → Incidents refetched and showed a skeleton
/// each time. Each segment loads lazily on first appearance.
@MainActor
@Observable
final class AlertsHubModels {
	let incidents: IncidentsListModel
	let issues: IssuesListModel
	let anomalies: AnomaliesListModel
	let scope: SessionController.DataScope

	/// The scope's environment reaches issues and anomalies, whose endpoints
	/// take the filter, and is ignored by incidents, whose endpoints do not —
	/// the scoped client is still handed to all three so the day `/v2/alerts`
	/// grows the parameter, this segment starts honouring it without another
	/// change here.
	init(session: SessionController, scope: SessionController.DataScope) {
		let api = session.api.scoped(toEnvironment: scope.environment)
		incidents = IncidentsListModel(api: api, session: session)
		issues = IssuesListModel(api: api, session: session)
		anomalies = AnomaliesListModel(api: api, session: session)
		self.scope = scope
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
