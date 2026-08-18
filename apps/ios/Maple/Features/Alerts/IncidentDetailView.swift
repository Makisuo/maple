import Charts
import MapleAPI
import SwiftUI

/// Everything the "why" screen needs, gathered in one pass.
struct IncidentDetail {
	var incident: AlertIncident
	var rule: AlertRule?
	var display: SignalDisplay
	/// The rule's own evaluations around the incident, oldest first.
	var checks: [AlertCheck]
	/// The service the incident is about, when the rule names exactly one
	/// (or when the group key is a service name). Drives the "what changed on
	/// the service" section; nil means that section is skipped.
	var serviceName: String?
	var errorRate: [Double]
	var p95: [Double]
	var throughput: [Double]
	var telemetryWindow: ResolvedTimeWindow?
	var linkedIssue: ErrorIssueDetail?
	var recentIssues: [ErrorIssue]
	var failingOperations: [BreakdownItem]
	var deliveries: [AlertDelivery]
}

@MainActor
@Observable
final class IncidentDetailModel {
	private(set) var loader: ScreenLoader<IncidentDetail>!

	let incidentID: String
	let generation: Int
	private let api: any MapleAPI

	init(incidentID: String, api: any MapleAPI, session: SessionController) {
		self.incidentID = incidentID
		self.api = api
		self.generation = session.dataGeneration
		self.loader = ScreenLoader(session: session) { [unowned self] in try await self.fetch() }
	}

	var state: LoadState<IncidentDetail> { loader.state }

	private func fetch() async throws -> IncidentDetail {
		let incident = try await api.alertIncident(id: incidentID)
		let rule = try? await api.alertRule(id: incident.ruleId)
		let display = rule.map(SignalDisplay.init(rule:)) ?? SignalDisplay(signal: incident.signalType)

		// The window the story happens in: an hour of run-up, then until it
		// resolved (or now). Capped at a day so a week-old incident doesn't
		// pull a week of buckets.
		let opened = ResolvedTimeWindow.parse(incident.firstTriggeredAt) ?? Date()
		let closed = incident.resolvedAt.flatMap(ResolvedTimeWindow.parse) ?? Date()
		let end = min(closed.addingTimeInterval(15 * 60), Date())
		let start = max(opened.addingTimeInterval(-3600), end.addingTimeInterval(-24 * 3600))
		let window = ResolvedTimeWindow(start: snapMinute(start), end: snapMinute(end))

		let serviceName = Self.serviceName(for: incident, rule: rule)

		async let checksTask = api.alertRuleChecks(
			ruleId: incident.ruleId, groupKey: incident.groupKey, since: window.start, limit: 100
		)
		async let deliveriesTask = api.alertDeliveries(incidentId: incident.id, limit: 50)
		async let linkedIssueTask: ErrorIssueDetail? = {
			guard let id = incident.errorIssueId else { return nil }
			return try? await api.issue(id: id)
		}()

		var errorRate: [Double] = []
		var p95: [Double] = []
		var throughput: [Double] = []
		var recentIssues: [ErrorIssue] = []
		var failing: [BreakdownItem] = []

		if let serviceName {
			async let errorTask = api.traceTimeseries(
				TraceTimeseriesRequest(aggregation: .errorRate, window: window, serviceName: serviceName)
			)
			async let p95Task = api.traceTimeseries(
				TraceTimeseriesRequest(aggregation: .p95Duration, window: window, serviceName: serviceName)
			)
			async let countTask = api.traceTimeseries(
				TraceTimeseriesRequest(aggregation: .count, window: window, serviceName: serviceName)
			)
			async let issuesTask = api.issues(
				query: IssueQuery(serviceName: serviceName, actionableOnly: true, sort: .lastSeen),
				window: window,
				limit: 5,
				cursor: nil
			)
			async let breakdownTask = api.traceBreakdown(
				TraceBreakdownRequest(
					aggregation: .count, groupBy: .spanName, window: window, serviceName: serviceName, hasError: true,
					limit: 5
				)
			)
			errorRate = (try? await errorTask.values) ?? []
			p95 = (try? await p95Task.values) ?? []
			throughput = (try? await countTask.values) ?? []
			recentIssues = ((try? await issuesTask.items) ?? []).filter { $0.id != incident.errorIssueId }
			failing = (try? await breakdownTask.data) ?? []
		}

		return IncidentDetail(
			incident: incident,
			rule: rule,
			display: display,
			checks: (try? await checksTask) ?? [],
			serviceName: serviceName,
			errorRate: errorRate,
			p95: p95,
			throughput: throughput,
			telemetryWindow: serviceName == nil ? nil : window,
			linkedIssue: await linkedIssueTask,
			recentIssues: recentIssues,
			failingOperations: failing,
			deliveries: (try? await deliveriesTask) ?? []
		)
	}

	/// A grouped-by-service rule puts the service in the group key; a rule
	/// scoped to one service names it. Anything broader has no single service
	/// to tell a story about.
	private static func serviceName(for incident: AlertIncident, rule: AlertRule?) -> String? {
		if let rule, rule.serviceNames.count == 1 { return rule.serviceNames[0] }
		if let group = incident.groupKey, group != "__total__", let rule,
			rule.groupBy != nil, rule.serviceNames.isEmpty || rule.serviceNames.contains(group)
		{
			return group
		}
		return nil
	}

	private func snapMinute(_ date: Date) -> Date {
		Date(timeIntervalSince1970: (date.timeIntervalSince1970 / 60).rounded(.down) * 60)
	}
}

struct IncidentDetailView: View {
	let incidentID: String

	@Environment(SessionController.self) private var session
	@State private var model: IncidentDetailModel?

	var body: some View {
		ZStack {
			Token.background.ignoresSafeArea()
			LoadableView(
				loader: model?.loader,
				emptyTitle: "Not found",
				emptyMessage: "This incident no longer exists.",
				skeleton: { DetailSkeleton(leadsWithHeadline: true) }
			) { detail in
				IncidentDetailContent(detail: detail)
			}
		}
		.navigationTitle("Incident")
		.navigationBarTitleDisplayMode(.inline)
		.toolbar {
			if let detail = model?.state.value {
				ToolbarItem(placement: .topBarTrailing) {
					ShareLink(item: shareText(detail)) {
						Image(systemName: "square.and.arrow.up")
							.font(.system(size: 14, weight: .medium))
							.foregroundStyle(Token.foreground)
					}
				}
			}
		}
		.task(id: session.dataGeneration) {
			let model = model?.generation == session.dataGeneration
				? model! : IncidentDetailModel(incidentID: incidentID, api: session.api, session: session)
			self.model = model
			await model.loader.loadIfNeeded()
		}
		// The first incident someone reads is the moment "tell me next time"
		// makes sense — so this is where the permission prompt lives, once.
		.task { await PushRegistrar.shared.promptIfNeeded() }
	}

	private func shareText(_ detail: IncidentDetail) -> String {
		let incident = detail.incident
		let breach = Format.breach(
			observed: incident.lastObservedValue,
			comparator: incident.comparator,
			threshold: incident.threshold,
			upper: incident.thresholdUpper,
			unit: detail.display.unit
		)
		let service = detail.serviceName.map { " on \($0)" } ?? ""
		let state = incident.status == .open ? "open \(Format.duration(from: incident.firstTriggeredAt))" : "resolved"
		return "\(incident.ruleName) — \(detail.display.label) \(breach)\(service) · \(incident.severity.label), \(state)"
	}
}

private struct IncidentDetailContent: View {
	let detail: IncidentDetail

	var body: some View {
		VStack(alignment: .leading, spacing: 28) {
			IncidentHeader(detail: detail)
			WhatTheRuleSaw(detail: detail)
			if detail.telemetryWindow != nil {
				WhatChanged(detail: detail)
			}
			LikelyCause(detail: detail)
			IncidentTimeline(detail: detail)
			RuleFacts(detail: detail)
		}
		.padding(.vertical, 16)
	}
}

private struct Block<Content: View>: View {
	let title: String
	@ViewBuilder let content: Content

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			SectionLabel(title)
				.padding(.horizontal, 16)
			content
		}
	}
}

private struct IncidentHeader: View {
	let detail: IncidentDetail

	private var incident: AlertIncident { detail.incident }
	private var isOpen: Bool { incident.status == .open }
	private var tint: Color { isOpen ? incident.severity.tint : Token.mutedForeground }

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			HStack(spacing: 6) {
				MapleBadge(text: incident.severity.label, tint: incident.severity.tint)
				MapleBadge(
					text: isOpen ? "Open" : "Resolved",
					tint: isOpen ? Token.destructive : Token.success
				)
				Spacer()
				Text(
					isOpen
						? "open \(Format.duration(from: incident.firstTriggeredAt))"
						: "lasted \(Format.duration(from: incident.firstTriggeredAt, to: incident.resolvedAt))"
				)
				.font(Typo.tiny)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground)
			}

			Text(incident.ruleName)
				.font(Typo.monoTitle)
				.foregroundStyle(Token.foreground)
				.fixedSize(horizontal: false, vertical: true)

			HStack(alignment: .firstTextBaseline, spacing: 8) {
				Text(detail.display.label)
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
				Text(
					Format.breach(
						observed: incident.lastObservedValue,
						comparator: incident.comparator,
						threshold: incident.threshold,
						upper: incident.thresholdUpper,
						unit: detail.display.unit
					)
				)
				.font(Typo.smallSemibold)
				.tabularNumbers()
				.foregroundStyle(tint)
			}

			if let serviceName = detail.serviceName {
				NavigationLink(value: Route.service(name: serviceName, window: .lastHour)) {
					HStack(spacing: 6) {
						ServiceDot(serviceName: serviceName, size: 7)
						Text(serviceName)
							.font(Typo.smallMedium)
							.foregroundStyle(Token.foreground)
						Image(systemName: "chevron.right")
							.font(.system(size: 9, weight: .semibold))
							.foregroundStyle(Token.mutedForeground.opacity(0.6))
					}
				}
				.buttonStyle(.plain)
			} else if let rule = detail.rule, !rule.serviceNames.isEmpty {
				Text(rule.serviceNames.joined(separator: ", "))
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
					.lineLimit(2)
			}
		}
		.padding(.horizontal, 16)
	}
}

/// The rule's own observations with its threshold — the one chart that
/// exists for every signal type, because it's what the rule evaluated rather
/// than a re-query.
private struct WhatTheRuleSaw: View {
	let detail: IncidentDetail

	private struct Point: Identifiable {
		let id: String
		let date: Date
		let value: Double
		let breached: Bool
	}

	private var points: [Point] {
		detail.checks.compactMap { check in
			guard let value = check.observedValue, let date = ResolvedTimeWindow.parse(check.timestamp) else {
				return nil
			}
			return Point(id: check.timestamp, date: date, value: value, breached: check.status == .breached)
		}
	}

	var body: some View {
		Block(title: "What the rule saw") {
			let points = points
			if points.count < 2 {
				Text("Not enough evaluations to chart yet.")
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
					.padding(.horizontal, 16)
			} else {
				VStack(alignment: .leading, spacing: 8) {
					Chart {
						ForEach(points) { point in
							AreaMark(x: .value("Time", point.date), y: .value("Value", point.value))
								.foregroundStyle(
									.linearGradient(
										colors: [detail.incident.severity.tint.opacity(0.18), .clear],
										startPoint: .top,
										endPoint: .bottom
									)
								)
								.interpolationMethod(.monotone)
							LineMark(x: .value("Time", point.date), y: .value("Value", point.value))
								.foregroundStyle(detail.incident.severity.tint)
								.lineStyle(StrokeStyle(lineWidth: 1.25))
								.interpolationMethod(.monotone)
						}
						ForEach(points.filter(\.breached)) { point in
							PointMark(x: .value("Time", point.date), y: .value("Value", point.value))
								.foregroundStyle(detail.incident.severity.tint)
								.symbolSize(10)
						}
						RuleMark(y: .value("Threshold", detail.incident.threshold))
							.foregroundStyle(Token.mutedForeground.opacity(0.8))
							.lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
							.annotation(position: .top, alignment: .trailing) {
								Text(detail.display.unit.format(detail.incident.threshold))
									.font(Typo.micro)
									.tabularNumbers()
									.foregroundStyle(Token.mutedForeground)
							}
						if let upper = detail.incident.thresholdUpper {
							RuleMark(y: .value("Upper", upper))
								.foregroundStyle(Token.mutedForeground.opacity(0.8))
								.lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
						}
					}
					.chartXAxis {
						AxisMarks(values: .automatic(desiredCount: 4)) { _ in
							AxisGridLine().foregroundStyle(Token.border)
							AxisValueLabel(format: .dateTime.hour().minute())
								.font(Typo.micro)
								.foregroundStyle(Token.mutedForeground)
						}
					}
					.chartYAxis {
						AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { value in
							AxisGridLine().foregroundStyle(Token.border)
							AxisValueLabel {
								if let number = value.as(Double.self) {
									Text(detail.display.unit.format(number))
										.font(Typo.micro)
										.tabularNumbers()
										.foregroundStyle(Token.mutedForeground)
								}
							}
						}
					}
					// The last x-axis label is centred on the final gridline, so
					// without a trailing inset half of it renders outside the plot
					// and gets cut ("9:5…" instead of "9:52 AM"). With the inset
					// Charts drops an overflowing label instead of slicing it, which
					// is the better of the two failures.
					.chartPlotStyle { $0.padding(.trailing, 14) }
					.frame(height: 150)
					.padding(.horizontal, 16)

					HStack(spacing: 12) {
						Legend(text: "\(points.filter(\.breached).count) breached", tint: detail.incident.severity.tint)
						Legend(text: "\(points.filter { !$0.breached }.count) healthy", tint: Token.mutedForeground)
						if let rule = detail.rule {
							Spacer(minLength: 0)
							Text("\(rule.windowMinutes)m window · \(rule.consecutiveBreachesRequired) to open")
								.font(Typo.micro)
								.tabularNumbers()
								.foregroundStyle(Token.mutedForeground.opacity(0.7))
						}
					}
					.padding(.horizontal, 16)
				}
			}
		}
	}

	private struct Legend: View {
		let text: String
		let tint: Color

		var body: some View {
			HStack(spacing: 5) {
				Circle().fill(tint).frame(width: 5, height: 5)
				Text(text)
					.font(Typo.micro)
					.tabularNumbers()
					.foregroundStyle(Token.mutedForeground)
			}
		}
	}
}

/// The service's three golden signals over the same window, so a latency
/// alert can show that errors spiked too, or that traffic did.
private struct WhatChanged: View {
	let detail: IncidentDetail

	var body: some View {
		Block(title: "What changed on \(detail.serviceName ?? "the service")") {
			StatGrid(columns: 3) {
				SignalTile(
					label: "Error rate",
					value: SignalUnit.ratio.format(detail.errorRate.latest),
					valueTint: detail.errorRate.latest.map(Tone.errorRate) ?? Token.mutedForeground,
					values: detail.errorRate,
					tint: Token.chartError
				)
				SignalTile(
					label: "p95",
					value: SignalUnit.milliseconds.format(detail.p95.latest),
					valueTint: detail.p95.latest.map { Tone.latency($0, scale: .p95) } ?? Token.mutedForeground,
					values: detail.p95,
					tint: Token.chartP95
				)
				SignalTile(
					label: "Requests",
					value: SignalUnit.count.format(detail.throughput.latest),
					values: detail.throughput,
					tint: Token.mutedForeground
				)
			}
			.padding(.horizontal, 16)
		}
	}
}

/// A stat tile with the shape of the window under the number.
struct SignalTile: View {
	let label: String
	let value: String
	var valueTint: Color = Token.foreground
	let values: [Double]
	let tint: Color

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			Text(label).sectionLabelStyle().lineLimit(1)
			Text(value)
				.font(Typo.statValue)
				.tabularNumbers()
				.foregroundStyle(valueTint)
				.lineLimit(1)
				.minimumScaleFactor(0.6)
			Sparkline(values: values, tint: tint)
				.frame(height: 24)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(.horizontal, 12)
		.padding(.vertical, 12)
		.background(Token.card)
	}
}

extension Array where Element == Double {
	/// The most recent finite bucket, for a tile whose number should read as
	/// "now" rather than "over the window".
	var latest: Double? { last(where: \.isFinite) }
}

private struct LikelyCause: View {
	let detail: IncidentDetail

	private var hasAnything: Bool {
		detail.linkedIssue != nil || !detail.recentIssues.isEmpty || !detail.failingOperations.isEmpty
	}

	var body: some View {
		Block(title: "Likely cause") {
			if !hasAnything {
				Text(
					detail.serviceName == nil
						? "This rule spans several services, so there is no single service to correlate."
						: "No error issues or failing operations in the window."
				)
				.font(Typo.small)
				.foregroundStyle(Token.mutedForeground)
				.padding(.horizontal, 16)
			}

			if let linked = detail.linkedIssue {
				VStack(alignment: .leading, spacing: 6) {
					Text("Linked issue")
						.font(Typo.micro)
						.foregroundStyle(Token.mutedForeground.opacity(0.7))
						.padding(.horizontal, 16)
					NavigationLink(value: Route.issue(id: linked.id)) {
						LinkedIssueRow(issue: linked)
					}
					.buttonStyle(RowButtonStyle())
					Hairline()
				}
			}

			if !detail.recentIssues.isEmpty {
				VStack(alignment: .leading, spacing: 6) {
					Text("Errors in the window")
						.font(Typo.micro)
						.foregroundStyle(Token.mutedForeground.opacity(0.7))
						.padding(.horizontal, 16)
					VStack(spacing: 0) {
						ForEach(detail.recentIssues, id: \.id) { issue in
							NavigationLink(value: Route.issue(id: issue.id)) {
								IssueRow(issue: issue, showsService: false)
							}
							.buttonStyle(RowButtonStyle())
							Hairline()
						}
					}
				}
			}

			if !detail.failingOperations.isEmpty {
				VStack(alignment: .leading, spacing: 6) {
					Text("Failing operations")
						.font(Typo.micro)
						.foregroundStyle(Token.mutedForeground.opacity(0.7))
						.padding(.horizontal, 16)
					BreakdownList(items: detail.failingOperations, unit: .count, tint: Token.chartError)
				}
			}
		}
	}
}

private struct LinkedIssueRow: View {
	let issue: ErrorIssueDetail

	var body: some View {
		HStack(alignment: .top, spacing: 10) {
			SeverityBadge(severity: issue.severity)
				.frame(width: 56, alignment: .leading)
			VStack(alignment: .leading, spacing: 4) {
				Text(issue.exceptionType.isEmpty ? issue.errorLabel : issue.exceptionType)
					.font(Typo.bodyMedium)
					.foregroundStyle(Token.foreground)
					.lineLimit(1)
				Text(issue.exceptionMessage)
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
					.lineLimit(2)
			}
			Spacer(minLength: 0)
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 12)
		.contentShape(.rect)
	}
}

/// Ranked bars, from the web's breakdown lists: name, value, and a bar scaled
/// to the largest entry.
struct BreakdownList: View {
	let items: [BreakdownItem]
	let unit: SignalUnit
	let tint: Color

	var body: some View {
		let peak = items.map(\.value).max() ?? 1
		VStack(spacing: 0) {
			ForEach(Array(items.enumerated()), id: \.offset) { _, item in
				VStack(alignment: .leading, spacing: 5) {
					HStack(alignment: .firstTextBaseline) {
						Text(item.name.isEmpty ? "(unnamed)" : item.name)
							.font(Typo.small)
							.foregroundStyle(Token.foreground)
							.lineLimit(1)
						Spacer(minLength: 8)
						Text(unit.format(item.value))
							.font(Typo.smallMedium)
							.tabularNumbers()
							.foregroundStyle(Token.foreground)
					}
					GeometryReader { proxy in
						Rectangle()
							.fill(tint.opacity(0.7))
							.frame(width: max(2, proxy.size.width * CGFloat(peak > 0 ? item.value / peak : 0)))
					}
					.frame(height: 3)
				}
				.padding(.horizontal, 16)
				.padding(.vertical, 8)
				Hairline()
			}
		}
	}
}

/// Trigger / re-notify / resolve, and where each went.
private struct IncidentTimeline: View {
	let detail: IncidentDetail

	private struct Event: Identifiable {
		let id: String
		let at: String
		let title: String
		let detail: String?
		let tint: Color
	}

	private var events: [Event] {
		var events: [Event] = []
		let incident = detail.incident
		events.append(
			Event(id: "opened", at: incident.firstTriggeredAt, title: "Opened", detail: nil, tint: incident.severity.tint)
		)
		for delivery in detail.deliveries {
			let ok = delivery.status == .success
			events.append(
				Event(
					id: delivery.id,
					at: delivery.attemptedAt ?? delivery.scheduledAt,
					title: "\(delivery.eventType.label) → \(delivery.destinationName)",
					detail: ok
						? delivery.destinationType.label
						: (delivery.errorMessage ?? delivery.status.rawValue.capitalized),
					tint: ok ? Token.mutedForeground : Token.destructive
				)
			)
		}
		if let resolved = incident.resolvedAt {
			events.append(Event(id: "resolved", at: resolved, title: "Resolved", detail: nil, tint: Token.success))
		}
		return events.sorted { $0.at < $1.at }
	}

	var body: some View {
		Block(title: "Timeline") {
			VStack(spacing: 0) {
				ForEach(events) { event in
					HStack(alignment: .firstTextBaseline, spacing: 10) {
						Text(Format.timelineTime(event.at))
							.font(Typo.tiny)
							.tabularNumbers()
							.foregroundStyle(Token.mutedForeground)
							.lineLimit(1)
							.frame(width: 96, alignment: .leading)
						Circle()
							.fill(event.tint)
							.frame(width: 5, height: 5)
							.offset(y: -1)
						VStack(alignment: .leading, spacing: 2) {
							Text(event.title)
								.font(Typo.small)
								.foregroundStyle(Token.foreground)
								.lineLimit(1)
							if let detail = event.detail {
								Text(detail)
									.font(Typo.tiny)
									.foregroundStyle(event.tint == Token.destructive ? Token.destructive : Token.mutedForeground)
									.lineLimit(2)
							}
						}
						Spacer(minLength: 0)
					}
					.padding(.horizontal, 16)
					.padding(.vertical, 8)
					Hairline()
				}
				if detail.deliveries.isEmpty {
					Text("No notifications were sent for this incident.")
						.font(Typo.tiny)
						.foregroundStyle(Token.mutedForeground.opacity(0.7))
						.padding(.horizontal, 16)
						.padding(.top, 8)
				}
			}
		}
	}
}

private struct RuleFacts: View {
	let detail: IncidentDetail

	var body: some View {
		Block(title: "Rule") {
			VStack(spacing: 0) {
				DetailRow(
					"Condition",
					"\(detail.display.label) \(detail.incident.comparator.glyph) \(detail.display.unit.format(detail.incident.threshold))"
				)
				Hairline()
				if let rule = detail.rule {
					DetailRow("Window", "\(rule.windowMinutes)m, min \(rule.minimumSampleCount) samples")
					Hairline()
					DetailRow("Opens after", "\(rule.consecutiveBreachesRequired) consecutive breaches")
					Hairline()
					DetailRow("Resolves after", "\(rule.consecutiveHealthyRequired) healthy checks")
					Hairline()
					if !rule.environments.isEmpty {
						DetailRow("Environments", rule.environments.joined(separator: ", "))
						Hairline()
					}
					if let notes = rule.notes, !notes.isEmpty {
						DetailRow("Notes", notes)
						Hairline()
					}
				}
				if let count = detail.incident.lastSampleCount {
					// The value is the check's sample size, not a time — "Last
					// sample" read as a timestamp next to a count.
					DetailRow("Last check", "\(Format.count(count)) samples")
					Hairline()
				}
			}
			.padding(.horizontal, 16)
		}
	}
}
