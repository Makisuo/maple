import MapleWidgetData
import SwiftUI
import WidgetKit

/// Throughput, in every family the widget supports.
///
/// The hierarchy is rate → shape → quality: how much traffic, whether it is
/// going up or down, and whether that traffic is healthy. Error rate sits
/// beside the number rather than under a chart, because a widget's reader
/// needs "is this fine" answered in the same glance as "how busy is it".
struct ThroughputWidgetView: View {
	let entry: ThroughputEntry

	@Environment(\.widgetFamily) private var family

	var body: some View {
		content
			// A configured widget opens its service; the org-wide one opens the
			// Services tab. `AppNavigation.open(_:)` handles both.
			.widgetURL(ThroughputWidgetKind.serviceURL(name: entry.serviceName, organizationId: entry.organizationId))
	}

	@ViewBuilder
	private var content: some View {
		switch family {
		case .accessoryInline: InlineThroughputView(entry: entry)
		case .accessoryRectangular: RectangularThroughputView(entry: entry)
		case .systemLarge: LargeThroughputView(entry: entry)
		case .systemMedium: MediumThroughputView(entry: entry)
		default: SmallThroughputView(entry: entry)
		}
	}
}

// MARK: - Home Screen

private struct SmallThroughputView: View {
	let entry: ThroughputEntry

	var body: some View {
		ThroughputFrame(entry: entry) { service, snapshot in
			VStack(alignment: .leading, spacing: 0) {
				ThroughputHeader(service: service, snapshot: snapshot, organizationName: entry.headerOrganizationName)
				RateLine(service: service)
				TrendLine(service: service, snapshot: snapshot)

				Spacer(minLength: 6)

				Sparkline(values: service.points, tint: Token.primary)
					.frame(height: 34)

				QualityLine(service: service)
					.padding(.top, 6)
			}
		}
	}
}

private struct MediumThroughputView: View {
	let entry: ThroughputEntry

	var body: some View {
		ThroughputFrame(entry: entry) { service, snapshot in
			HStack(alignment: .top, spacing: 14) {
				VStack(alignment: .leading, spacing: 0) {
					ThroughputHeader(service: service, snapshot: snapshot, organizationName: entry.headerOrganizationName)
					RateLine(service: service)
					TrendLine(service: service, snapshot: snapshot)
					Spacer(minLength: 4)
					QualityLine(service: service, isStacked: true)
				}
				.frame(maxWidth: 150, alignment: .leading)

				// No window label here: `TrendLine` already carries it, and the
				// medium family is too small to say "last hour" twice.
				Sparkline(values: service.points, tint: Token.primary)
					.frame(maxHeight: .infinity)
			}
		}
	}
}

private struct LargeThroughputView: View {
	let entry: ThroughputEntry

	var body: some View {
		ThroughputFrame(entry: entry) { service, snapshot in
			VStack(alignment: .leading, spacing: 0) {
				ThroughputHeader(service: service, snapshot: snapshot, organizationName: entry.headerOrganizationName)
				RateLine(service: service)
				TrendLine(service: service, snapshot: snapshot)

				Sparkline(values: service.points, tint: Token.primary)
					.frame(height: 78)
					.padding(.top, 8)

				QualityLine(service: service)
					.padding(.top, 8)

				// Only the org-wide widget lists services: on a widget already
				// scoped to one service, its own name repeated as a row is
				// noise. A per-service breakdown of operations belongs in the
				// app, which has room for it.
				if service.name == nil, !snapshot.services.isEmpty {
					Divider().overlay(Token.border).padding(.vertical, 8)
					VStack(alignment: .leading, spacing: 6) {
						ForEach(snapshot.services.prefix(5)) { row in
							ServiceRateRow(service: row)
						}
					}
				}

				Spacer(minLength: 0)

				Text(windowLabel(snapshot))
					.font(Typo.micro)
					.foregroundStyle(Token.mutedForeground)
			}
		}
	}
}

private struct ServiceRateRow: View {
	let service: ServiceThroughput

	var body: some View {
		HStack(spacing: 8) {
			ServiceDot(serviceName: service.displayName, size: 6)
			Text(service.displayName)
				.font(Typo.small)
				.foregroundStyle(Token.foreground)
				.lineLimit(1)
			Spacer(minLength: 4)
			// Error rate first, and only when there is one: a column of "0%"
			// down the right-hand side is the noise this rule exists to avoid.
			if service.errorRate > 0 {
				Text(WidgetFormat.errorRate(service.errorRate))
					.font(Typo.tiny)
					.tabularNumbers()
					.foregroundStyle(errorTint(service.errorRate))
			}
			Text(WidgetFormat.rate(service.throughputPerSecond))
				.font(Typo.smallMedium)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground)
		}
	}
}

// MARK: - Lock Screen

private struct RectangularThroughputView: View {
	let entry: ThroughputEntry

	var body: some View {
		ThroughputFrame(entry: entry, isAccessory: true) { service, _ in
			VStack(alignment: .leading, spacing: 2) {
				Text(WidgetFormat.rate(service.throughputPerSecond))
					.font(.headline)
					.widgetAccentable()
				Text(service.displayName)
					.font(.caption)
					.lineLimit(1)
				Text(
					[WidgetFormat.errorRate(service.errorRate) + " errors", WidgetFormat.trend(service.trend)]
						.compactMap { $0 }
						.joined(separator: " · ")
				)
				.font(.caption2)
				.foregroundStyle(.secondary)
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
	}
}

private struct InlineThroughputView: View {
	let entry: ThroughputEntry

	var body: some View {
		if let service = entry.service {
			Text("\(service.displayName) \(WidgetFormat.rate(service.throughputPerSecond))")
		} else if entry.snapshot == nil {
			Text("Maple — open to connect")
		} else {
			Text("\(entry.serviceName ?? "Maple") — no traffic")
		}
	}
}

// MARK: - Shared

/// The three states: never published, a configured service the snapshot no
/// longer carries, and content.
private struct ThroughputFrame<Content: View>: View {
	let entry: ThroughputEntry
	var isAccessory = false
	@ViewBuilder let content: (ServiceThroughput, ThroughputSnapshot) -> Content

	var body: some View {
		Group {
			if let snapshot = entry.snapshot, let service = entry.service {
				content(service, snapshot)
					// Stale data stays — it is still the last truth we had —
					// but stops looking live.
					.opacity(snapshot.isStale(at: entry.date) ? 0.55 : 1)
			} else if entry.snapshot != nil {
				// Configured for a service that is not in the snapshot. Saying
				// so is the whole point: falling back to the org total here
				// would read as "your service is fine".
				MissingServiceView(name: entry.serviceName, isAccessory: isAccessory)
			} else if entry.isOrganizationUnavailable {
				MissingOrganizationView(
					name: entry.organizationName,
					isMember: false,
					isAccessory: isAccessory
				)
			} else if let organizationName = entry.organizationName {
				// Pinned to an organization this round did not publish.
				MissingOrganizationView(name: organizationName, isMember: true, isAccessory: isAccessory)
			} else {
				DisconnectedThroughputView(isAccessory: isAccessory)
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.redacted(reason: entry.isPlaceholder ? .placeholder : [])
	}
}

private struct ThroughputHeader: View {
	let service: ServiceThroughput
	let snapshot: ThroughputSnapshot
	/// Only when the account publishes more than one organization.
	var organizationName: String?

	var body: some View {
		VStack(alignment: .leading, spacing: 1) {
			HStack(spacing: 5) {
				if service.name != nil {
					ServiceDot(serviceName: service.displayName, size: 6)
				}
				Text(service.displayName)
					.sectionLabelStyle()
					.lineLimit(1)
			}
			if let organizationName {
				HStack(spacing: 4) {
					ServiceDot(serviceName: snapshot.organizationId, size: 6)
					Text(organizationName)
						.font(Typo.micro)
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(1)
				}
			}
		}
	}
}

/// The widget is pinned to an organization that has nothing published — either
/// because the app has not covered it yet, or because the user is no longer in
/// it. Never falls back to another organization's numbers: one organization's
/// traffic under another's name is the same error as opening the wrong
/// organization from a notification.
private struct MissingOrganizationView: View {
	let name: String?
	let isMember: Bool
	let isAccessory: Bool

	var body: some View {
		if isAccessory {
			Text(isMember ? "Open Maple" : (name ?? "Unavailable"))
				.font(.headline)
				.widgetAccentable()
		} else {
			VStack(alignment: .leading, spacing: 4) {
				Text(name ?? "Organization").sectionLabelStyle()
				Text(isMember ? "Open Maple" : "Unavailable")
					.font(Typo.heading)
					.foregroundStyle(Token.foreground)
				Text(
					isMember
						? "Open the app once to load this organization's traffic."
						: "You're no longer a member. Edit this widget to pick another organization."
				)
				.font(Typo.tiny)
				.foregroundStyle(Token.mutedForeground)
				.fixedSize(horizontal: false, vertical: true)
			}
		}
	}
}

private struct RateLine: View {
	let service: ServiceThroughput

	var body: some View {
		Text(WidgetFormat.rate(service.throughputPerSecond))
			.font(Typo.statValue)
			.tabularNumbers()
			.foregroundStyle(Token.foreground)
			.minimumScaleFactor(0.7)
			.lineLimit(1)
	}
}

private struct TrendLine: View {
	let service: ServiceThroughput
	let snapshot: ThroughputSnapshot

	var body: some View {
		Text(label)
			.font(Typo.tiny)
			.tabularNumbers()
			.foregroundStyle(Token.mutedForeground)
			.lineLimit(1)
	}

	private var label: String {
		guard let trend = WidgetFormat.trend(service.trend) else { return windowLabel(snapshot) }
		return "\(trend) · \(windowLabel(snapshot))"
	}
}

/// Error rate and p95 — "is this traffic healthy", next to how much of it there
/// is. The rate is tinted only once it is out of range, so a healthy widget
/// carries no colour and an unhealthy one carries exactly one.
private struct QualityLine: View {
	let service: ServiceThroughput
	var isStacked = false

	var body: some View {
		let layout = isStacked
			? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
			: AnyLayout(HStackLayout(spacing: 10))

		layout {
			HStack(spacing: 4) {
				Text("err")
					.font(Typo.micro)
					.foregroundStyle(Token.mutedForeground)
				Text(WidgetFormat.errorRate(service.errorRate))
					.font(Typo.tinyMedium)
					.tabularNumbers()
					.foregroundStyle(errorTint(service.errorRate))
			}
			HStack(spacing: 4) {
				Text("p95")
					.font(Typo.micro)
					.foregroundStyle(Token.mutedForeground)
				Text(WidgetFormat.latency(service.p95LatencyMs))
					.font(Typo.tinyMedium)
					.tabularNumbers()
					.foregroundStyle(Token.foreground)
			}
		}
	}
}

private struct MissingServiceView: View {
	let name: String?
	let isAccessory: Bool

	var body: some View {
		if isAccessory {
			Text("No traffic").font(.headline).widgetAccentable()
		} else {
			VStack(alignment: .leading, spacing: 4) {
				Text(name ?? "Service").sectionLabelStyle().lineLimit(1)
				Text("No traffic")
					.font(Typo.heading)
					.foregroundStyle(Token.foreground)
				Text("Nothing reported in the last hour.")
					.font(Typo.tiny)
					.foregroundStyle(Token.mutedForeground)
					.fixedSize(horizontal: false, vertical: true)
			}
		}
	}
}

private struct DisconnectedThroughputView: View {
	let isAccessory: Bool

	var body: some View {
		if isAccessory {
			Text("Open Maple").font(.headline).widgetAccentable()
		} else {
			VStack(alignment: .leading, spacing: 4) {
				Text("Maple").sectionLabelStyle()
				Text("Open Maple")
					.font(Typo.heading)
					.foregroundStyle(Token.foreground)
				Text("Sign in to see throughput here.")
					.font(Typo.tiny)
					.foregroundStyle(Token.mutedForeground)
					.fixedSize(horizontal: false, vertical: true)
			}
		}
	}
}

/// "last hour" / "last 24h", from what the app actually asked for rather than
/// from a hardcoded string that drifts when the window changes.
private func windowLabel(_ snapshot: ThroughputSnapshot) -> String {
	let minutes = snapshot.windowMinutes
	if minutes % 1440 == 0 { return "last \(minutes / 1440)d" }
	if minutes % 60 == 0 {
		let hours = minutes / 60
		return hours == 1 ? "last hour" : "last \(hours)h"
	}
	return "last \(minutes)m"
}

/// The Services tab's thresholds: 5% is unhealthy, 1% is worth noticing.
private func errorTint(_ ratio: Double) -> Color {
	if ratio >= 0.05 { return Token.destructive }
	if ratio >= 0.01 { return Token.severityWarn }
	return Token.mutedForeground
}
