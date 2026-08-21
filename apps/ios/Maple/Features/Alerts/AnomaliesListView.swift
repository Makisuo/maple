import MapleAPI
import SwiftUI

@MainActor
@Observable
final class AnomaliesListModel {
	private(set) var loader: ScreenLoader<[AnomalyIncident]>!
	var openOnly = true {
		didSet { if openOnly != oldValue { Task { await loader.load(.replace) } } }
	}

	private let api: any MapleAPI

	init(api: any MapleAPI, session: SessionController) {
		self.api = api
		self.loader = ScreenLoader(session: session, screen: Screen.anomalies, isEmpty: { $0.isEmpty }) { [unowned self] in
			try await self.api.anomalyIncidents(
				status: self.openOnly ? .open : nil,
				serviceName: nil,
				window: self.openOnly ? nil : TimeWindow.last7Days.resolve(),
				limit: 50,
				cursor: nil
			).items
		}
	}

	var state: LoadState<[AnomalyIncident]> { loader.state }
}

struct AnomaliesListView: View {
	/// Owned by the hub so switching segments doesn't refetch; see
	/// `AlertsHubModels`.
	let model: AnomaliesListModel

	var body: some View {
		LoadableView(
			loader: model.loader,
			emptyTitle: model.openOnly ? "No anomalies" : "Nothing detected",
			emptyMessage: model.openOnly
				? "Every monitored signal is inside its baseline."
				: "No anomalies in the last 7 days.",
			skeletonRowHeight: 64
		) { anomalies in
			LazyVStack(spacing: 0) {
				ForEach(anomalies, id: \.id) { anomaly in
					NavigationLink(value: Route.anomaly(id: anomaly.id)) {
						AnomalyRow(anomaly: anomaly)
					}
					.buttonStyle(RowButtonStyle())
					Hairline()
				}
			}
		}
		.toolbar {
			ToolbarItem(placement: .topBarTrailing) {
				Button {
					model.openOnly.toggle()
				} label: {
					Text(model.openOnly ? "Open" : "7 days")
						.font(Typo.smallMedium)
						.foregroundStyle(model.openOnly ? Token.primary : Token.foreground)
				}
			}
		}
		.task { await model.loader.loadIfNeeded() }
		.mapleScreen(Screen.anomalies)
	}
}

struct AnomalyRow: View {
	let anomaly: AnomalyIncident

	private var isOpen: Bool { anomaly.status == .open }
	private var tint: Color { isOpen ? anomaly.severity.tint : Token.mutedForeground }
	private var unit: SignalUnit { anomaly.signalType.unit }

	var body: some View {
		HStack(alignment: .top, spacing: 12) {
			Rectangle()
				.fill(isOpen ? anomaly.severity.tint : .clear)
				.frame(width: 2)

			VStack(alignment: .leading, spacing: 5) {
				HStack(alignment: .firstTextBaseline, spacing: 8) {
					HStack(spacing: 6) {
						ServiceDot(serviceName: anomaly.serviceName)
						Text(anomaly.serviceName)
							.font(Typo.bodyMedium)
							.foregroundStyle(isOpen ? Token.foreground : Token.mutedForeground)
							.lineLimit(1)
					}
					Spacer(minLength: 4)
					Text(
						isOpen
							? Format.duration(from: anomaly.firstTriggeredAt)
							: "resolved \(Format.lastSeen(anomaly.resolvedAt ?? anomaly.lastTriggeredAt))"
					)
					.font(Typo.tiny)
					.tabularNumbers()
					.foregroundStyle(Token.mutedForeground)
				}

				HStack(spacing: 8) {
					MapleBadge(text: anomaly.signalType.label, tint: tint)
					if !anomaly.deploymentEnv.isEmpty {
						Text(anomaly.deploymentEnv)
							.font(Typo.tiny)
							.foregroundStyle(Token.mutedForeground)
							.lineLimit(1)
					}
					Spacer(minLength: 0)
					Text("\(unit.format(anomaly.lastObservedValue)) vs \(unit.format(anomaly.baselineMedian))")
						.font(Typo.tiny)
						.tabularNumbers()
						.foregroundStyle(tint)
						.lineLimit(1)
				}
			}
		}
		.padding(.trailing, 16)
		.padding(.vertical, 12)
		.frame(minHeight: 64)
		.contentShape(.rect)
	}
}
