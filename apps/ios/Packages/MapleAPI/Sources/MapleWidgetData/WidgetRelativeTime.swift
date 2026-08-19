import Foundation

/// `Format.lastSeen` for a `Date`, so the widget reads the same as the app's
/// issue rows: "now", "12m", "3h", "5d", then an abbreviated date.
///
/// The app's version takes the raw ISO string off the wire and lives beside the
/// other ported formatters; this one takes the decoded `Date` the snapshot
/// carries. Both must agree — an issue that says "3h" in the list and "4h" on
/// the Home Screen reads as a bug in the data.
public enum WidgetTime {
	public static func lastSeen(_ date: Date, now: Date = Date()) -> String {
		let elapsed = now.timeIntervalSince(date)
		if elapsed < 60 { return "now" }
		if elapsed < 3600 { return "\(Int(elapsed / 60))m" }
		if elapsed < 86_400 { return "\(Int(elapsed / 3600))h" }
		if elapsed < 604_800 { return "\(Int(elapsed / 86_400))d" }

		let calendar = Calendar.current
		let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
		return date.formatted(
			sameYear
				? .dateTime.month(.abbreviated).day()
				: .dateTime.month(.abbreviated).day().year()
		)
	}

	/// "as of 12m ago" for the footer. Spelled out rather than terse, because
	/// here the age is the subject rather than a column.
	public static func age(_ interval: TimeInterval) -> String {
		if interval < 60 { return "just now" }
		if interval < 3600 { return "\(Int(interval / 60))m ago" }
		if interval < 86_400 { return "\(Int(interval / 3600))h ago" }
		return "\(Int(interval / 86_400))d ago"
	}

	/// `Format.count`'s K/M/B abbreviation, for the per-row event count.
	public static func count(_ value: Double) -> String {
		guard value.isFinite else { return "—" }
		let magnitude = abs(value)
		if magnitude >= 1_000_000_000 { return trimmed(value / 1_000_000_000) + "B" }
		if magnitude >= 1_000_000 { return trimmed(value / 1_000_000) + "M" }
		if magnitude >= 1000 { return trimmed(value / 1000) + "K" }
		return String(Int(value.rounded()))
	}

	private static func trimmed(_ value: Double) -> String {
		value == value.rounded() ? String(Int(value.rounded())) : String(format: "%.1f", value)
	}
}
