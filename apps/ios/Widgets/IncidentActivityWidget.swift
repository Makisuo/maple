import ActivityKit
import MapleWidgetData
import SwiftUI
import WidgetKit

/// The Lock Screen Live Activity for a critical incident.
///
/// Declared in the widget extension like any other widget, but nothing here is
/// on a timeline: the content is whatever the last APNs push said, and the only
/// thing that moves on its own is the elapsed timer. See `LiveActivityController`
/// in the app for the two tokens that make that push possible, and
/// `MobilePushService.syncLiveActivities` for who sends it.
struct IncidentActivityWidget: Widget {
	var body: some WidgetConfiguration {
		ActivityConfiguration(for: IncidentActivityAttributes.self) { context in
			IncidentActivityLockScreenView(
				attributes: context.attributes,
				state: context.state
			)
			.activityBackgroundTint(Token.card)
			.activitySystemActionForegroundColor(Token.foreground)
			.widgetURL(context.attributes.deepLinkURL)
		} dynamicIsland: { context in
			DynamicIsland {
				DynamicIslandExpandedRegion(.leading) {
					VStack(alignment: .leading, spacing: 2) {
						Text(context.attributes.ruleName)
							.font(Typo.smallSemibold)
							.lineLimit(1)
						if let service = context.attributes.service {
							Text(service)
								.font(Typo.micro)
								.foregroundStyle(Token.mutedForeground)
								.lineLimit(1)
						}
					}
				}
				DynamicIslandExpandedRegion(.trailing) {
					VStack(alignment: .trailing, spacing: 2) {
						Text(context.state.value)
							.font(Typo.monoTitle)
							.tabularNumbers()
							.foregroundStyle(context.state.status.tint)
						Text(context.state.threshold)
							.font(Typo.micro)
							.foregroundStyle(Token.mutedForeground)
					}
				}
				DynamicIslandExpandedRegion(.bottom) {
					VStack(spacing: 6) {
						if context.state.series.count >= 3 {
							Sparkline(
								values: context.state.series,
								tint: context.state.status.tint,
								reference: context.state.thresholdValue,
								anchorsToZero: false
							)
							.frame(height: 28)
						}
						HStack {
							SignalStateChip(
								status: context.state.status,
								label: context.attributes.signalLabel
							)
							Spacer()
							ElapsedLabel(
								startedAt: context.attributes.startedAt,
								status: context.state.status
							)
						}
					}
				}
			} compactLeading: {
				Circle()
					.fill(context.state.status.tint)
					.frame(width: 8, height: 8)
			} compactTrailing: {
				Text(context.state.value)
					.font(Typo.tinyMedium)
					.tabularNumbers()
					.foregroundStyle(context.state.status.tint)
			} minimal: {
				// One glyph's worth of space: the colour is the message, and the
				// value is behind a long-press.
				Circle()
					.fill(context.state.status.tint)
					.frame(width: 8, height: 8)
			}
			.widgetURL(context.attributes.deepLinkURL)
			.keylineTint(context.state.status.tint)
		}
	}
}

extension IncidentActivityStatus {
	/// Red while it is breaching, emerald once it has recovered. Never the brand
	/// amber: this surface is about severity, not about Maple.
	var tint: Color {
		switch self {
		case .firing: Token.destructive
		case .resolved: Token.success
		}
	}

	var label: String {
		switch self {
		case .firing: "Critical"
		case .resolved: "Resolved"
		}
	}
}
