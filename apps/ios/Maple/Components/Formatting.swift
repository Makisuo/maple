import Foundation
import MapleAPI
import SwiftUI

/// Number and time formatting, ported from `packages/ui/src/lib/format.ts` and
/// `services-table.tsx`.
///
/// These rules are more specific than they look — `<0.01%` rather than `0%` for
/// a tiny-but-nonzero error rate is the difference between "this service is
/// fine" and "this service is failing rarely", and matching the web exactly
/// means a number never disagrees across surfaces.
enum Format {
	/// `formatErrorRate`: takes a 0–1 ratio.
	/// 0 → "0%"; below 0.01% → "<0.01%"; below 1% → 2dp; below 10% → 1dp; else integer.
	static func errorRate(_ ratio: Double) -> String {
		guard ratio.isFinite else { return "—" }
		let pct = ratio * 100
		if pct == 0 { return "0%" }
		if pct < 0.01 { return "<0.01%" }
		if pct < 1 { return String(format: "%.2f%%", pct) }
		if pct < 10 { return String(format: "%.1f%%", pct) }
		return "\(Int(pct.rounded()))%"
	}

	/// `formatThroughput`: 0 → "0/s"; ≥1000 → "1.2k/s"; ≥1 → 1dp; else 3dp.
	static func throughput(_ perSecond: Double) -> String {
		guard perSecond.isFinite else { return "—" }
		if perSecond == 0 { return "0/s" }
		if perSecond >= 1000 { return String(format: "%.1fk/s", perSecond / 1000) }
		if perSecond >= 1 { return String(format: "%.1f/s", perSecond) }
		return String(format: "%.3f/s", perSecond)
	}

	/// `formatLatency`: sub-ms in μs, then ms, s, min, h.
	static func latency(_ ms: Double) -> String {
		guard ms.isFinite else { return "—" }
		if ms < 1 { return "\(Int((ms * 1000).rounded()))μs" }
		if ms < 1000 { return String(format: "%.1fms", ms) }
		if ms < 60_000 { return String(format: "%.2fs", ms / 1000) }
		if ms < 3_600_000 { return String(format: "%.1fmin", ms / 60_000) }
		return String(format: "%.1fh", ms / 3_600_000)
	}

    /// `formatNumber`: T/B/M/K with 1dp.
	static func count(_ value: Double) -> String {
		guard value.isFinite else { return "—" }
		let magnitude = abs(value)
		if magnitude >= 1_000_000_000_000 { return trimmed(value / 1_000_000_000_000) + "T" }
		if magnitude >= 1_000_000_000 { return trimmed(value / 1_000_000_000) + "B" }
		if magnitude >= 1_000_000 { return trimmed(value / 1_000_000) + "M" }
		if magnitude >= 1000 { return trimmed(value / 1000) + "K" }
		if magnitude > 0, magnitude < 1 { return String(format: "%.3g", value) }
		return String(Int(value.rounded()))
	}

	/// `formatLastSeen` — deliberately terse, and deliberately without "ago":
	/// "now", "12m", "3h", "5d", then an abbreviated date.
	static func lastSeen(_ timestamp: String) -> String {
		guard let date = ResolvedTimeWindow.parse(timestamp) else { return "—" }
		let elapsed = Date().timeIntervalSince(date)
		if elapsed < 60 { return "now" }
		if elapsed < 3600 { return "\(Int(elapsed / 60))m" }
		if elapsed < 86_400 { return "\(Int(elapsed / 3600))h" }
		if elapsed < 604_800 { return "\(Int(elapsed / 86_400))d" }

		let calendar = Calendar.current
		let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: Date())
		return date.formatted(
			sameYear
				? .dateTime.month(.abbreviated).day()
				: .dateTime.month(.abbreviated).day().year()
		)
	}

	static func absolute(_ timestamp: String) -> String {
		guard let date = ResolvedTimeWindow.parse(timestamp) else { return "—" }
		return date.formatted(date: .abbreviated, time: .shortened)
	}

	/// At most one decimal, and none when it would be `.0`.
	private static func trimmed(_ value: Double) -> String {
		value == value.rounded()
			? String(Int(value.rounded()))
			: String(format: "%.1f", value)
	}
}
