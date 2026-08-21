import Foundation

/// Numbers, formatted exactly as the app formats them.
///
/// Ported from the app's `Format`, which is itself ported from the web's
/// `format.ts`. Duplicated rather than shared because this module deliberately
/// has no dependencies — and the rules are the point: `<0.01%` rather than
/// `0%` is the difference between "this service is fine" and "this service is
/// failing rarely", and a widget disagreeing with the screen behind it is
/// worse than either number alone.
public enum WidgetFormat {
	/// `12.5/s`. Sub-1 rates keep three decimals — a service at 0.004/s is
	/// meaningfully different from one at zero.
	public static func rate(_ perSecond: Double) -> String {
		guard perSecond.isFinite else { return "—" }
		if perSecond == 0 { return "0/s" }
		if perSecond >= 1000 { return String(format: "%.1fk/s", perSecond / 1000) }
		if perSecond >= 1 { return String(format: "%.1f/s", perSecond) }
		return String(format: "%.3f/s", perSecond)
	}

	/// Takes a 0–1 ratio.
	public static func errorRate(_ ratio: Double) -> String {
		guard ratio.isFinite else { return "—" }
		let percent = ratio * 100
		if percent == 0 { return "0%" }
		if percent < 0.01 { return "<0.01%" }
		if percent < 1 { return String(format: "%.2f%%", percent) }
		if percent < 10 { return String(format: "%.1f%%", percent) }
		return "\(Int(percent.rounded()))%"
	}

	public static func latency(_ ms: Double) -> String {
		guard ms.isFinite else { return "—" }
		if ms < 1 { return "\(Int((ms * 1000).rounded()))μs" }
		if ms < 1000 { return String(format: "%.0fms", ms) }
		if ms < 60_000 { return String(format: "%.2fs", ms / 1000) }
		return String(format: "%.1fmin", ms / 60_000)
	}

	/// A signed ratio as a direction: `+21%`, `-8%`, or "steady".
	///
	/// Traffic wobbles, so anything inside ±5% is called steady rather than
	/// dressed up as a trend — a widget that says "+3%" every fifteen minutes
	/// teaches the reader to ignore it.
	public static func trend(_ ratio: Double?) -> String? {
		guard let ratio, ratio.isFinite else { return nil }
		if abs(ratio) < 0.05 { return "steady" }
		let percent = Int((abs(ratio) * 100).rounded())
		return "\(ratio > 0 ? "+" : "-")\(percent)%"
	}
}
