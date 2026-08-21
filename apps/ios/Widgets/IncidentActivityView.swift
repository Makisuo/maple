import ActivityKit
import MapleWidgetData
import SwiftUI
import WidgetKit

/// The Lock Screen presentation: one card, read at arm's length, in the dark.
///
/// Hierarchy is severity → what broke → the number → how long. The rule name
/// outranks the service because a rule is what someone configured and therefore
/// what they recognise; the service is the qualifier.
struct IncidentActivityLockScreenView: View {
	let attributes: IncidentActivityAttributes
	let state: IncidentActivityAttributes.ContentState

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			HStack(alignment: .top, spacing: 12) {
				VStack(alignment: .leading, spacing: 4) {
					HStack(spacing: 6) {
						SignalStateChip(status: state.status, label: attributes.signalLabel)
						Spacer(minLength: 0)
					}

					Text(attributes.ruleName)
						.font(Typo.heading)
						.foregroundStyle(Token.foreground)
						.lineLimit(1)

					Text(attributes.service ?? "All services")
						.font(Typo.tiny)
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(1)
				}

				VStack(alignment: .trailing, spacing: 2) {
					Text(state.value)
						.font(Typo.statValue)
						.tabularNumbers()
						.minimumScaleFactor(0.6)
						.lineLimit(1)
						.foregroundStyle(state.status.tint)

					Text(state.threshold)
						.font(Typo.micro)
						.tabularNumbers()
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(1)

					ElapsedLabel(startedAt: attributes.startedAt, status: state.status)
				}
			}

			// Its own row, full width: the chart answers what the number cannot
			// — still climbing, or coming back down — and it needs the width to
			// say it. Squeezed in beside the text it cost the rule name its
			// last six characters, which is the one thing that must stay whole.
			// Only drawn once there is a trend: two points is a line segment.
			if state.series.count >= 3 {
				Sparkline(
					values: state.series,
					tint: state.status.tint,
					reference: state.thresholdValue,
					anchorsToZero: false
				)
				.frame(height: 30)
			}
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 12)
	}
}

/// The severity word, beside a dot — colour is never the only carrier.
struct SignalStateChip: View {
	let status: IncidentActivityStatus
	let label: String

	var body: some View {
		HStack(spacing: 5) {
			Circle()
				.fill(status.tint)
				.frame(width: 6, height: 6)
			Text("\(status.label) · \(label)")
				.font(Typo.microMedium)
				.textCase(.uppercase)
				.tracking(1.1)
				.foregroundStyle(Token.mutedForeground)
				.lineLimit(1)
		}
	}
}

/// How long this has been going on.
///
/// A live `.timer` while it is firing — the one thing on the Lock Screen that
/// stays true without a push, and the number that turns "something is wrong"
/// into "something has been wrong for 40 minutes". Once resolved it stops: a
/// counter still running under the word "Resolved" reads as unresolved.
struct ElapsedLabel: View {
	let startedAt: Date
	let status: IncidentActivityStatus

	var body: some View {
		Group {
			switch status {
			case .firing:
				Text(startedAt, style: .timer)
					.multilineTextAlignment(.trailing)
			case .resolved:
				Text("recovered")
			}
		}
		.font(Typo.micro)
		.tabularNumbers()
		.foregroundStyle(Token.mutedForeground)
		.lineLimit(1)
	}
}

#Preview("Lock Screen", as: .content, using: IncidentActivityAttributes.sample) {
	IncidentActivityWidget()
} contentStates: {
	IncidentActivityAttributes.ContentState.sample
	IncidentActivityAttributes.ContentState.resolvedSample
}
