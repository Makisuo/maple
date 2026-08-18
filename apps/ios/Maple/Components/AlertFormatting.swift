import Foundation
import MapleAPI
import OpenAPIRuntime
import SwiftUI

/// The unit an alert's observed value and threshold are read in. Mirrors
/// `apps/api/src/services/alerts/alert-signal-display.ts`: the unit travels
/// with the label because the same facts decide both — deriving them
/// separately is how a value and its threshold drift apart.
enum SignalUnit {
	case ratio
	case milliseconds
	case perMinute
	case apdex
	case count
	case plain

	func format(_ value: Double?) -> String {
		guard let value, value.isFinite else { return "—" }
		switch self {
		case .ratio: return Format.errorRate(value)
		case .milliseconds: return Format.latency(value)
		case .perMinute: return Format.count(value) + "/min"
		case .apdex: return String(format: "%.2f", value)
		case .count, .plain: return Format.count(value)
		}
	}
}

struct SignalDisplay {
	let label: String
	let unit: SignalUnit

	/// From the incident alone. `builder_query` / `raw_query` say only "this
	/// rule runs a query", so they read as a plain number until the rule
	/// arrives with its draft.
	init(signal: AlertSignalType) {
		switch signal {
		case .errorRate: self.init(label: "Error rate", unit: .ratio)
		case .p95Latency: self.init(label: "p95 latency", unit: .milliseconds)
		case .p99Latency: self.init(label: "p99 latency", unit: .milliseconds)
		case .apdex: self.init(label: "Apdex", unit: .apdex)
		case .throughput: self.init(label: "Throughput", unit: .perMinute)
		case .builderQuery: self.init(label: "Query", unit: .plain)
		case .rawQuery: self.init(label: "Raw query", unit: .plain)
		}
	}

	/// From the rule, which knows what a builder query measures.
	init(rule: AlertRule) {
		switch rule.signalType {
		case .builderQuery:
			guard let draft = rule.queryBuilderDraft?.value else {
				self.init(signal: .builderQuery)
				return
			}
			let aggregation = (draft["aggregation"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
			let name = (draft["name"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
			let source = draft["dataSource"] as? String
			let unit: SignalUnit
			if source == "traces", aggregation.hasSuffix("_duration") {
				unit = .milliseconds
			} else if source == "traces", aggregation == "error_rate" {
				unit = .ratio
			} else if aggregation == "count" {
				unit = .count
			} else {
				unit = .plain
			}
			let label: String
			if let metric = draft["metricName"] as? String, !metric.isEmpty, !aggregation.isEmpty {
				label = "\(aggregation)(\(metric))"
			} else if !aggregation.isEmpty {
				label = aggregation.replacingOccurrences(of: "_", with: " ")
			} else {
				label = name.isEmpty ? "Query" : name
			}
			self.init(label: label, unit: unit)
		case .rawQuery:
			self.init(label: rule.rawQueryReducer?.rawValue ?? "Raw query", unit: .plain)
		default:
			self.init(signal: rule.signalType)
		}
	}

	init(label: String, unit: SignalUnit) {
		self.label = label
		self.unit = unit
	}
}

extension AlertComparator {
	/// The operator as it reads in a headline: `9.0% > 5.0%`.
	var glyph: String {
		switch self {
		case .gt: ">"
		case .gte: "≥"
		case .lt: "<"
		case .lte: "≤"
		case .eq: "="
		case .neq: "≠"
		case .between: "in"
		case .notBetween: "outside"
		}
	}
}

extension AlertSeverity {
	var label: String { rawValue.capitalized }
	var tint: Color {
		switch self {
		case .critical: Token.destructive
		case .warning: Token.severityWarn
		}
	}
}

extension AnomalyIncidentSeverity {
	var label: String { rawValue.capitalized }
	var tint: Color {
		switch self {
		case .critical: Token.destructive
		case .warning: Token.severityWarn
		}
	}
}

extension AnomalySignalType {
	var label: String {
		switch self {
		case .errorRate: "Error rate"
		case .latencyP95: "p95 latency"
		case .throughput: "Throughput"
		case .errorSpike: "Error spike"
		case .logVolume: "Log volume"
		}
	}

	var unit: SignalUnit {
		switch self {
		case .errorRate: .ratio
		case .latencyP95: .milliseconds
		case .throughput: .perMinute
		case .errorSpike, .logVolume: .count
		}
	}
}

extension AlertEventType {
	var label: String {
		switch self {
		case .trigger: "Triggered"
		case .resolve: "Resolved"
		case .renotify: "Re-notified"
		case .test: "Test"
		}
	}
}

extension AlertDestinationType {
	var label: String {
		switch self {
		case .slackBot: "Slack"
		case .pagerduty: "PagerDuty"
		case .webhook: "Webhook"
		case .hazelOauth: "Hazel"
		case .discord: "Discord"
		case .email: "Email"
		}
	}
}

extension Format {
	/// A timeline stamp: `11:44` today, `Aug 15, 11:44` otherwise. One line,
	/// always — the timeline's date column is fixed-width.
	static func timelineTime(_ timestamp: String) -> String {
		guard let date = ResolvedTimeWindow.parse(timestamp) else { return "—" }
		if Calendar.current.isDateInToday(date) {
			return date.formatted(date: .omitted, time: .shortened)
		}
		return date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
	}

	/// "32m", "3h 12m", "2d 4h" — how long something has been going on. Terse
	/// like `lastSeen`, but two units once it passes an hour, because "3h" for
	/// an incident hides whether it's fresh or nearly four.
	static func duration(from startText: String, to endText: String? = nil) -> String {
		guard let start = ResolvedTimeWindow.parse(startText) else { return "—" }
		let end = endText.flatMap(ResolvedTimeWindow.parse) ?? Date()
		return duration(seconds: end.timeIntervalSince(start))
	}

	static func duration(seconds: TimeInterval) -> String {
		let total = max(0, Int(seconds))
		if total < 60 { return "<1m" }
		let minutes = total / 60
		if minutes < 60 { return "\(minutes)m" }
		let hours = minutes / 60
		if hours < 24 {
			let rest = minutes % 60
			return rest == 0 ? "\(hours)h" : "\(hours)h \(rest)m"
		}
		let days = hours / 24
		let rest = hours % 24
		return rest == 0 ? "\(days)d" : "\(days)d \(rest)h"
	}

	/// The comparison as a sentence fragment: `9.0% > 5.0%`, or `— > 5.0%`
	/// when nothing has been observed yet.
	static func breach(observed: Double?, comparator: AlertComparator, threshold: Double, upper: Double?, unit: SignalUnit)
		-> String
	{
		let observedText = unit.format(observed)
		switch comparator {
		case .between, .notBetween:
			return "\(observedText) \(comparator.glyph) \(unit.format(threshold))–\(unit.format(upper))"
		default:
			return "\(observedText) \(comparator.glyph) \(unit.format(threshold))"
		}
	}
}
