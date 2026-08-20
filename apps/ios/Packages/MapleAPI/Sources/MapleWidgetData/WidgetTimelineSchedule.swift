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

	/// One timeline request an hour. iOS meters those against the same budget as
	/// the app's `reloadTimelines` calls, so this is the half of the budget the
	/// widget spends on its own; see `WidgetPublisher` for the other half.
	public static let refreshAfter: TimeInterval = 60 * 60

	public static func entryDates(from date: Date) -> [Date] {
		offsetMinutes.map { date.addingTimeInterval(Double($0) * 60) }
	}

	public static func refreshDate(from date: Date) -> Date {
		date.addingTimeInterval(refreshAfter)
	}
}
