import Foundation

/// When a widget's timeline should render, and when WidgetKit should come back
/// for a new one.
///
/// Both Home Screen widgets read their snapshot **once** per timeline build and
/// then reuse it for every entry: the data does not change between entries,
/// only its age does. So the entries exist purely to keep the relative labels
/// honest — "12m", "Updated 4m ago" — and they are free, because WidgetKit
/// pre-renders them from one build.
///
/// The *policy* is the part that costs. iOS meters how often it will rebuild a
/// timeline, and the same budget pays for the app's own `reloadTimelines`
/// calls — which are what actually make the widget current when something
/// happens. So this asks for one rebuild an hour and spends the rest of the
/// budget on reloads; see `WidgetPublisher`.
public enum WidgetTimelineSchedule {
	/// Minutes from the build, front-loaded: a snapshot's age reads "1m", "2m",
	/// "5m" in its first quarter hour and then changes far more slowly, so
	/// evenly spaced entries would be wrong exactly where the reader is most
	/// likely to be looking.
	///
	/// The tail past `refreshAfter` is the part that is easy to leave out and
	/// shouldn't be: if iOS throttles the rebuild, these are what let the widget
	/// keep saying an honest "90m" instead of insisting forever that it is an
	/// hour old.
	public static let offsetMinutes: [Int] = [0, 1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120]

	/// One timeline request roughly every three quarters of an hour.
	///
	/// **Deliberately not shortened now that the widget fetches for itself.**
	/// The date in a `TimelineReloadPolicy` is a floor, not a promise: iOS grants
	/// rebuilds from a budget derived from how often the widget is actually
	/// looked at, and asking four times as often does not produce four times as
	/// many. What it does produce is a widget that spends its whole allotment by
	/// mid-afternoon and goes cold in the evening — which is exactly when an
	/// on-call user needs it. Every granted rebuild now returns fresh data
	/// instead of re-rendering what is already on screen; that is where the win
	/// is, not in asking more often.
	public static let refreshAfter: TimeInterval = 45 * 60

	public static func entryDates(from date: Date) -> [Date] {
		offsetMinutes.map { date.addingTimeInterval(Double($0) * 60) }
	}

	/// When to come back, given how the last fetches went.
	///
	/// A flat interval spends the same budget whether the widget is healthy or
	/// permanently broken. A credential the app has to re-mint answers 401 on
	/// every attempt, and without a backoff those attempts are the entire day's
	/// rebuilds — so a widget that cannot fix itself must stop asking so often
	/// and let the app's own reload wake it when there is something to say.
	///
	/// The short retry sits at *one* failure, not at repeated ones: a single
	/// miss is usually a tunnel or a dropped connection, and being back inside a
	/// quarter of an hour is worth one rebuild.
	public static func refreshDate(from date: Date, consecutiveFailures: Int = 0) -> Date {
		date.addingTimeInterval(refreshInterval(consecutiveFailures: consecutiveFailures))
	}

	public static func refreshInterval(consecutiveFailures: Int) -> TimeInterval {
		switch consecutiveFailures {
		case ..<1: refreshAfter
		case 1: 15 * 60
		case 2: 30 * 60
		case 3: 60 * 60
		default: 4 * 60 * 60
		}
	}
}
