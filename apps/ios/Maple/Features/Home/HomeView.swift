import MapleAPI
import SwiftUI

/// The pulse. Everything above the fold answers "is anything wrong right now";
/// everything below it is the shortest path to "why".
struct HomeView: View {
	@Environment(SessionController.self) private var session
	@Environment(AppNavigation.self) private var navigation
	@Environment(\.scenePhase) private var scenePhase
	@State private var model: HomeModel?
	@State private var showsNotificationSettings = false

	var body: some View {
		NavigationStack {
			ZStack {
				Token.background.ignoresSafeArea()
				LoadableView(
					loader: model?.loader,
					emptyTitle: "Nothing yet",
					emptyMessage: "No services have reported telemetry.",
					skeleton: { HomeSkeleton() }
				) { snapshot in
					HomeContent(snapshot: snapshot)
				}
			}
			// No title: `StatusHeadline` *is* this screen's headline, and a large
			// title above it stacked two competing headlines in the same face.
			// Home is a status board whose content leads — the bar carries only
			// the organization and the bell. Services and Alerts are lists and do
			// take large titles.
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .topBarLeading) {
					OrganizationSwitcherButton()
				}
				ToolbarItem(placement: .topBarTrailing) {
					Button {
						showsNotificationSettings = true
					} label: {
						Image(systemName: PushRegistrar.shared.authorization == .authorized ? "bell.badge" : "bell")
							.font(.system(size: 14, weight: .medium))
							.foregroundStyle(Token.foreground)
					}
					.accessibilityLabel("Notification settings")
				}
			}
			.sheet(isPresented: $showsNotificationSettings) {
				NotificationSettingsView().environment(session)
			}
			.mapleDestinations()
		}
		.task(id: session.dataGeneration) {
			// A new org means a new model: the old board is dropped rather than
			// left on screen until the new one arrives, and any refresh still
			// running against the old org has nowhere to write.
			let model = model?.generation == session.dataGeneration
				? model! : HomeModel(api: session.api, session: session)
			self.model = model
			await model.loader.loadIfNeeded()
			// Home is a status board: keep it current while it's on screen.
			// `.task` is cancelled when the tab goes away, so this never runs
			// off-tab; the scene-phase check keeps it from running off-screen.
			while !Task.isCancelled {
				try? await Task.sleep(for: .seconds(60))
				guard !Task.isCancelled, scenePhase == .active else { continue }
				await model.loader.load(.refresh)
			}
		}
		.onChange(of: scenePhase) { _, phase in
			// Coming back from the background: the board is as old as the
			// absence, so refresh unless it is genuinely fresh.
			guard phase == .active, let model, let loadedAt = model.state.value?.loadedAt,
				Date().timeIntervalSince(loadedAt) > 30
			else { return }
			Task { await model.loader.load(.refresh) }
		}
	}
}

private struct HomeContent: View {
	let snapshot: HomeSnapshot
	@Environment(AppNavigation.self) private var navigation

	var body: some View {
		VStack(alignment: .leading, spacing: 28) {
			StatusHeadline(snapshot: snapshot)
				.padding(.horizontal, 16)

			if !snapshot.incidents.isEmpty {
				HomeSection(title: "Open alerts", count: snapshot.incidents.count) {
					VStack(spacing: 8) {
						ForEach(snapshot.incidents) { card in
							NavigationLink(value: Route.incident(id: card.id)) {
								IncidentCardView(card: card)
							}
							.buttonStyle(.plain)
						}
					}
					.padding(.horizontal, 16)
				}
			}

			HomeSection(
				title: "Needs attention",
				count: snapshot.attention.isEmpty ? nil : snapshot.attention.count
			) {
				if snapshot.attention.isEmpty {
					QuietRow(
						text: snapshot.services.isEmpty
							? "No services reported in the last hour."
							: "All \(snapshot.services.count) services within thresholds."
					)
				} else {
					VStack(spacing: 0) {
						ForEach(snapshot.attention.prefix(6), id: \.name) { service in
							NavigationLink(value: Route.service(name: service.name, window: .lastHour)) {
								AttentionRow(service: service)
							}
							.buttonStyle(RowButtonStyle())
							Hairline()
						}
					}
				}
			}

			HomeSection(title: "Last 24 hours", count: nil) {
				VStack(spacing: 0) {
					CountRow(
						count: snapshot.newIssues,
						singular: "new error issue",
						plural: "new error issues",
						detail: snapshot.activeIssues > 0 ? "\(snapshot.activeIssues) still active" : nil,
						tint: snapshot.newIssues > 0 ? Token.foreground : Token.mutedForeground
					) { navigation.open(.errors) }
					Hairline()
					CountRow(
						count: snapshot.openAnomalies,
						singular: "anomaly open",
						plural: "anomalies open",
						detail: nil,
						tint: snapshot.openAnomalies > 0 ? Token.foreground : Token.mutedForeground
					) { navigation.open(.anomalies) }
					Hairline()
				}
			}

			Text("Updated \(snapshot.loadedAt.formatted(date: .omitted, time: .shortened))")
				.font(Typo.tiny)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground.opacity(0.6))
				.padding(.horizontal, 16)
		}
		.padding(.top, 8)
		.padding(.bottom, 24)
	}
}

/// The one place the display face carries a sentence, and the one place the
/// screen's colour is allowed to be loud.
private struct StatusHeadline: View {
	let snapshot: HomeSnapshot

	private var tint: Color {
		switch snapshot.status {
		case .noData: Token.mutedForeground
		case .healthy: Token.success
		case .degraded: Token.severityWarn
		case .critical: Token.destructive
		}
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			HStack(alignment: .firstTextBaseline, spacing: 10) {
				Circle()
					.fill(tint)
					.frame(width: 8, height: 8)
					.offset(y: -2)
				Text(snapshot.headline)
					.font(Typo.pageTitle)
					.foregroundStyle(Token.foreground)
					.fixedSize(horizontal: false, vertical: true)
			}
			Text(snapshot.subheadline)
				.font(Typo.small)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground)
				.padding(.leading, 18)
		}
		.padding(.top, 12)
		.accessibilityElement(children: .combine)
	}
}

private struct HomeSection<Content: View>: View {
	let title: String
	let count: Int?
	@ViewBuilder let content: Content

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			HStack(spacing: 6) {
				SectionLabel(title)
				if let count {
					Text("\(count)")
						.font(Typo.microMedium)
						.tabularNumbers()
						.foregroundStyle(Token.mutedForeground.opacity(0.7))
				}
			}
			.padding(.horizontal, 16)
			content
		}
	}
}

/// An open incident: severity lane, rule name and age, the services it covers,
/// then the breach in the signal's own unit beside the last hour of what the
/// rule saw.
struct IncidentCardView: View {
	let card: IncidentCard

	private var incident: AlertIncident { card.incident }

	var body: some View {
		HStack(alignment: .top, spacing: 0) {
			Rectangle()
				.fill(incident.severity.tint)
				.frame(width: 2)

			VStack(alignment: .leading, spacing: 8) {
				HStack(alignment: .firstTextBaseline, spacing: 8) {
					Text(incident.ruleName)
						.font(Typo.bodyMedium)
						.foregroundStyle(Token.foreground)
						.lineLimit(1)
					Spacer(minLength: 4)
					Text(Format.duration(from: incident.firstTriggeredAt))
						.font(Typo.tiny)
						.tabularNumbers()
						.foregroundStyle(Token.mutedForeground)
				}

				HStack(spacing: 6) {
					if let first = card.serviceNames.first {
						ServiceDot(serviceName: first, size: 6)
						Text(serviceLabel)
							.font(Typo.tiny)
							.foregroundStyle(Token.mutedForeground)
							.lineLimit(1)
					} else {
						Text("All services")
							.font(Typo.tiny)
							.foregroundStyle(Token.mutedForeground)
					}
					if let group = incident.groupKey, group != "__total__" {
						Text("· \(group)")
							.font(Typo.tiny)
							.foregroundStyle(Token.mutedForeground)
							.lineLimit(1)
					}
				}

				HStack(alignment: .bottom, spacing: 12) {
					VStack(alignment: .leading, spacing: 2) {
						Text(card.display.label)
							.font(Typo.micro)
							.foregroundStyle(Token.mutedForeground.opacity(0.7))
						Text(
							Format.breach(
								observed: incident.lastObservedValue,
								comparator: incident.comparator,
								threshold: incident.threshold,
								upper: incident.thresholdUpper,
								unit: card.display.unit
							)
						)
						.font(Typo.smallSemibold)
						.tabularNumbers()
						.foregroundStyle(incident.severity.tint)
					}
					Spacer(minLength: 0)
					Sparkline(values: card.observations, tint: incident.severity.tint, reference: incident.threshold)
						.frame(width: 96, height: 28)
				}
			}
			.padding(.leading, 12)
			.padding(.trailing, 12)
			.padding(.vertical, 12)
		}
		.background(Token.card, in: .rect(cornerRadius: Token.Radius.lg))
		.overlay(
			RoundedRectangle(cornerRadius: Token.Radius.lg)
				.stroke(Token.border, lineWidth: Token.hairline)
		)
		.contentShape(.rect)
	}

	private var serviceLabel: String {
		let names = card.serviceNames
		if names.count <= 2 { return names.joined(separator: ", ") }
		return "\(names[0]), \(names[1]) +\(names.count - 2)"
	}
}

private struct AttentionRow: View {
	let service: Service

	private var health: ServiceHealth {
		ServiceHealth(service: service)
	}

	var body: some View {
		HStack(spacing: 12) {
			Rectangle()
				.fill(health == .unhealthy ? Token.destructive : .clear)
				.frame(width: 2)
			ServiceDot(serviceName: service.name)
			Text(service.name)
				.font(Typo.bodyMedium)
				.foregroundStyle(Token.foreground)
				.lineLimit(1)
			HealthDot(health: health)
			Spacer(minLength: 8)
			HStack(spacing: 14) {
				Metric(label: "err", value: Format.errorRate(service.errorRate), tint: Tone.errorRate(service.errorRate))
				Metric(
					label: "p95",
					value: Format.latency(service.p95LatencyMs),
					tint: Tone.latency(service.p95LatencyMs, scale: .p95)
				)
			}
		}
		.padding(.trailing, 16)
		.frame(minHeight: 48)
		.contentShape(.rect)
	}

	private struct Metric: View {
		let label: String
		let value: String
		let tint: Color

		var body: some View {
			VStack(alignment: .trailing, spacing: 1) {
				Text(value)
					.font(Typo.smallSemibold)
					.tabularNumbers()
					.foregroundStyle(tint)
				Text(label)
					.font(Typo.micro)
					.foregroundStyle(Token.mutedForeground.opacity(0.6))
			}
			.frame(minWidth: 52, alignment: .trailing)
		}
	}
}

private struct CountRow: View {
	let count: Int
	let singular: String
	let plural: String
	let detail: String?
	let tint: Color
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			HStack(alignment: .firstTextBaseline, spacing: 8) {
				Text("\(count)")
					.font(Typo.statValue)
					.tabularNumbers()
					.foregroundStyle(tint)
					.frame(minWidth: 36, alignment: .leading)
				Text(count == 1 ? singular : plural)
					.font(Typo.body)
					.foregroundStyle(Token.foreground)
				if let detail {
					Text("· \(detail)")
						.font(Typo.small)
						.foregroundStyle(Token.mutedForeground)
				}
				Spacer(minLength: 0)
				Image(systemName: "chevron.right")
					.font(.system(size: 11, weight: .semibold))
					.foregroundStyle(Token.mutedForeground.opacity(0.5))
			}
			.padding(.horizontal, 16)
			.frame(minHeight: 52)
			.contentShape(.rect)
		}
		.buttonStyle(RowButtonStyle())
	}
}

private struct QuietRow: View {
	let text: String

	var body: some View {
		Text(text)
			.font(Typo.small)
			.foregroundStyle(Token.mutedForeground)
			.padding(.horizontal, 16)
	}
}
