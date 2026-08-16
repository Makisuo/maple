import Foundation
import MapleAPI
import SwiftUI

/// Presentation helpers shared by the services and issues screens.
enum Format {
	/// Compact counts: 45000 → "45K". Long lists of raw digits are unreadable
	/// at a glance, which is the only way these are read.
	static func count(_ value: Double) -> String {
		let rounded = value.rounded()
		switch abs(rounded) {
		case 1_000_000...:
			return "\(trim(rounded / 1_000_000))M"
		case 1000...:
			return "\(trim(rounded / 1000))K"
		default:
			return String(Int(rounded))
		}
	}

	/// `error_rate` arrives as a 0–1 ratio.
	static func percent(_ ratio: Double) -> String {
		guard ratio.isFinite else { return "—" }
		if ratio > 0, ratio < 0.001 { return "<0.1%" }
		return "\(trim(ratio * 100))%"
	}

	static func milliseconds(_ value: Double) -> String {
		guard value.isFinite else { return "—" }
		if value >= 1000 { return "\(trim(value / 1000))s" }
		return "\(trim(value))ms"
	}

	/// Spans per second, as reported by the API.
	static func throughput(_ value: Double) -> String {
		guard value.isFinite else { return "—" }
		return "\(trim(value))/s"
	}

	/// "2h ago". Timestamps here are always in the past.
	static func relative(_ timestamp: String) -> String {
		guard let date = ResolvedTimeWindow.parse(timestamp) else { return "—" }
		return date.formatted(relativeStyle)
	}

	static func absolute(_ timestamp: String) -> String {
		guard let date = ResolvedTimeWindow.parse(timestamp) else { return "—" }
		return date.formatted(date: .abbreviated, time: .shortened)
	}

	/// At most one decimal, and none when it would be `.0`.
	private static func trim(_ value: Double) -> String {
		value == value.rounded()
			? String(Int(value.rounded()))
			: String(format: "%.1f", value)
	}

	/// `RelativeDateTimeFormatter` is a class and not `Sendable`, so a shared
	/// instance will not compile under Swift 6. The format style is a value type.
	private static let relativeStyle = Date.RelativeFormatStyle(
		presentation: .numeric,
		unitsStyle: .abbreviated
	)
}

extension IssueSeverity {
	var title: String { rawValue.capitalized }

	var tint: Color {
		switch self {
		case .critical: .red
		case .high: .orange
		case .medium: .yellow
		case .low: .secondary
		}
	}
}

extension WorkflowState {
	var title: String {
		rawValue.replacingOccurrences(of: "_", with: " ").capitalized
	}
}

/// A service's error rate, coloured by how alarming it is.
///
/// Thresholds match the web dashboard's: 1% warns, 5% is critical.
func errorRateTint(_ ratio: Double) -> Color {
	switch ratio {
	case 0.05...: .red
	case 0.01..<0.05: .orange
	case ..<0.0001: .secondary
	default: .primary
	}
}

struct SeverityBadge: View {
	let severity: IssueSeverity?

	var body: some View {
		Text(severity?.title ?? "Unset")
			.font(.caption2.weight(.semibold))
			.padding(.horizontal, 6)
			.padding(.vertical, 2)
			.background((severity?.tint ?? .secondary).opacity(0.15), in: .capsule)
			.foregroundStyle(severity?.tint ?? .secondary)
	}
}

struct MetricTile: View {
	let label: String
	let value: String
	var tint: Color = .primary

	var body: some View {
		VStack(alignment: .leading, spacing: 4) {
			Text(label)
				.font(.caption)
				.foregroundStyle(.secondary)
			Text(value)
				.font(.title3.weight(.semibold))
				.foregroundStyle(tint)
				.contentTransition(.numericText())
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(12)
		.background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 10))
	}
}

/// The time-range control every data screen carries.
struct TimeWindowMenu: View {
	@Binding var window: TimeWindow

	var body: some View {
		Menu {
			Picker("Time range", selection: $window) {
				ForEach(TimeWindow.allCases) { option in
					Text(option.title).tag(option)
				}
			}
		} label: {
			Label(window.title, systemImage: "clock")
				.font(.subheadline)
		}
	}
}
