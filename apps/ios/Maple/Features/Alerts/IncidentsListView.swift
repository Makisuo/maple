import MapleAPI
import SwiftUI

@MainActor
@Observable
final class IncidentsListModel {
	private(set) var state: LoadState<[IncidentCard]> = .loading
	private(set) var isLoadingMore = false

	/// Open only by default: the hub is for triage, and history is one tap
	/// away. Resolved incidents are still listed after the open ones when
	/// the filter is off.
	var openOnly = true {
		didSet { if openOnly != oldValue { Task { await load() } } }
	}

	private var nextCursor: String?
	private var hasMore = false
	private var rules: [String: AlertRule] = [:]

	private let api: any MapleAPI
	private let session: SessionController

	init(api: any MapleAPI, session: SessionController) {
		self.api = api
		self.session = session
	}

	func load(showPlaceholder: Bool = true) async {
		if showPlaceholder && !state.hasContent { state = .loading }
		nextCursor = nil
		let next = await session.perform { () -> [IncidentCard] in
			async let rulesTask = self.api.alertRules(limit: 100, cursor: nil)
			let page = try await self.api.alertIncidents(
				status: self.openOnly ? .open : nil, ruleId: nil, limit: 30, cursor: nil
			)
			self.rules = Dictionary(
				((try? await rulesTask.items) ?? []).map { ($0.id, $0) },
				uniquingKeysWith: { first, _ in first }
			)
			self.nextCursor = page.nextCursor
			self.hasMore = page.hasMore
			return page.items.map(self.card)
		}
		guard let next else { return }
		if case .loaded(let cards) = next, cards.isEmpty {
			state = .empty
		} else {
			state = next
		}
	}

	func loadMore() async {
		guard hasMore, !isLoadingMore, let cursor = nextCursor, let existing = state.value else { return }
		isLoadingMore = true
		defer { isLoadingMore = false }
		guard
			let page = try? await api.alertIncidents(
				status: openOnly ? .open : nil, ruleId: nil, limit: 30, cursor: cursor
			)
		else {
			hasMore = false
			return
		}
		nextCursor = page.nextCursor
		hasMore = page.hasMore
		state = .loaded(existing + page.items.map(card))
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
	@Environment(SessionController.self) private var session
	@State private var model: IncidentsListModel?

	var body: some View {
		Group {
			if let model {
				LoadableView(
					state: model.state,
					emptyTitle: model.openOnly ? "No open alerts" : "No incidents",
					emptyMessage: model.openOnly
						? "Every alert rule is within its threshold."
						: "No alert rule has fired yet.",
					skeletonRowHeight: 72,
					retry: { Task { await model.load() } }
				) { cards in
					ScrollView {
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
					.scrollContentBackground(.hidden)
				}
				.refreshable { await model.load(showPlaceholder: false) }
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
			} else {
				SkeletonList(rowHeight: 72)
			}
		}
		.task(id: session.dataGeneration) {
			let model = model ?? IncidentsListModel(api: session.api, session: session)
			self.model = model
			await model.load()
		}
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
