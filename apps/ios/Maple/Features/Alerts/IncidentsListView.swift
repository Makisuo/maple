import MapleAPI
import SwiftUI

@MainActor
@Observable
final class IncidentsListModel {
	private(set) var loader: ScreenLoader<[IncidentCard]>!
	private(set) var isLoadingMore = false

	/// Open only by default: the hub is for triage, and history is one tap
	/// away. Resolved incidents are still listed after the open ones when
	/// the filter is off.
	var openOnly = true {
		didSet { if openOnly != oldValue { Task { await loader.load(.replace) } } }
	}

	private var nextCursor: String?
	private var hasMore = false
	private var rules: [String: AlertRule] = [:]

	private let api: any MapleAPI

	init(api: any MapleAPI, session: SessionController) {
		self.api = api
		self.loader = ScreenLoader(session: session, isEmpty: { $0.isEmpty }) { [unowned self] in try await self.fetchFirstPage() }
	}

	var state: LoadState<[IncidentCard]> { loader.state }

	private func fetchFirstPage() async throws -> [IncidentCard] {
		async let rulesTask = api.alertRules(limit: 100, cursor: nil)
		let page = try await api.alertIncidents(
			status: openOnly ? .open : nil, ruleId: nil, limit: 30, cursor: nil
		)
		rules = Dictionary(
			((try? await rulesTask.items) ?? []).map { ($0.id, $0) },
			uniquingKeysWith: { first, _ in first }
		)
		nextCursor = page.nextCursor
		hasMore = page.hasMore
		return page.items.map(card)
	}

	func loadMore() async {
		guard hasMore, !isLoadingMore, let cursor = nextCursor, state.value != nil else { return }
		isLoadingMore = true
		defer { isLoadingMore = false }
		let generation = loader.generation
		guard
			let page = try? await api.alertIncidents(
				status: openOnly ? .open : nil, ruleId: nil, limit: 30, cursor: cursor
			)
		else {
			if generation == loader.generation { hasMore = false }
			return
		}
		guard generation == loader.generation else { return }
		nextCursor = page.nextCursor
		hasMore = page.hasMore
		loader.update(ifGeneration: generation) { $0 + page.items.map(card) }
	}

	var canLoadMore: Bool { hasMore }

	private func card(_ incident: AlertIncident) -> IncidentCard {
		let rule = rules[incident.ruleId]
		return IncidentCard(
			incident: incident,
			serviceNames: rule?.serviceNames ?? [],
			display: rule.map(SignalDisplay.init(rule:)) ?? SignalDisplay(signal: incident.signalType),
			observations: []
		)
	}
}

struct IncidentsListView: View {
	/// Owned by the hub so switching segments doesn't refetch; see
	/// `AlertsHubModels`.
	let model: IncidentsListModel

	var body: some View {
		LoadableView(
			loader: model.loader,
			emptyTitle: model.openOnly ? "No open alerts" : "No incidents",
			emptyMessage: model.openOnly
				? "Every alert rule is within its threshold."
				: "No alert rule has fired yet.",
			skeletonRowHeight: 72
		) { cards in
			LazyVStack(spacing: 0) {
				ForEach(cards) { card in
					NavigationLink(value: Route.incident(id: card.id)) {
						IncidentRow(card: card)
					}
					.buttonStyle(RowButtonStyle())
					Hairline()
				}
				if model.canLoadMore {
					SkeletonList(rowHeight: 72, rows: 2)
						.frame(height: 144)
						.task { await model.loadMore() }
				}
			}
		}
		.toolbar {
			ToolbarItem(placement: .topBarTrailing) {
				Button {
					model.openOnly.toggle()
				} label: {
					Text(model.openOnly ? "Open" : "All")
						.font(Typo.smallMedium)
						.foregroundStyle(model.openOnly ? Token.primary : Token.foreground)
				}
			}
		}
		.task { await model.loader.loadIfNeeded() }
	}
}

/// Severity lane, rule name, age or resolution, services, breach.
struct IncidentRow: View {
	let card: IncidentCard

	private var incident: AlertIncident { card.incident }
	private var isOpen: Bool { incident.status == .open }
	private var tint: Color { isOpen ? incident.severity.tint : Token.mutedForeground }

	var body: some View {
		HStack(alignment: .top, spacing: 12) {
			Rectangle()
				.fill(isOpen ? incident.severity.tint : .clear)
				.frame(width: 2)

			VStack(alignment: .leading, spacing: 5) {
				HStack(alignment: .firstTextBaseline, spacing: 8) {
					Text(incident.ruleName)
						.font(Typo.bodyMedium)
						.foregroundStyle(isOpen ? Token.foreground : Token.mutedForeground)
						.lineLimit(1)
					Spacer(minLength: 4)
					if isOpen {
						Text(Format.duration(from: incident.firstTriggeredAt))
							.font(Typo.tiny)
							.tabularNumbers()
							.foregroundStyle(Token.mutedForeground)
					} else {
						Text("resolved \(Format.lastSeen(incident.resolvedAt ?? incident.lastTriggeredAt))")
							.font(Typo.tiny)
							.tabularNumbers()
							.foregroundStyle(Token.mutedForeground)
					}
				}

				HStack(spacing: 8) {
					MapleBadge(text: incident.severity.label, tint: tint)
					if let first = card.serviceNames.first {
						HStack(spacing: 5) {
							ServiceDot(serviceName: first, size: 6)
							Text(card.serviceNames.count > 1 ? "\(first) +\(card.serviceNames.count - 1)" : first)
								.font(Typo.tiny)
								.foregroundStyle(Token.mutedForeground)
								.lineLimit(1)
						}
					}
					Spacer(minLength: 0)
					Text(
						Format.breach(
							observed: incident.lastObservedValue,
							comparator: incident.comparator,
							threshold: incident.threshold,
							upper: incident.thresholdUpper,
							unit: card.display.unit
						)
					)
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
