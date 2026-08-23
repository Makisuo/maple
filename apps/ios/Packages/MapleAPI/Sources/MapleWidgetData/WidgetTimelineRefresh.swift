import Foundation

/// The one place a timeline provider turns "I am awake" into "and now the data
/// is current".
///
/// Both widgets do exactly the same thing here, and the interesting part — the
/// order of operations — is easy to get subtly wrong in two places: the fetch
/// must be an **enrichment** of a timeline that was already going to be built,
/// never a precondition. A provider that returns nothing costs a rebuild from a
/// metered budget and leaves whatever is on screen frozen for another hour.
public enum WidgetTimelineRefresh {
	/// What the provider should do with the result.
	public struct Outcome: Sendable {
		/// When to ask for the next timeline. Already backed off if the fetch
		/// failed, so a permanently broken widget stops spending the budget.
		public let refreshDate: Date
		/// The App Group has newer data — re-read the snapshot before building
		/// entries.
		public let didFetch: Bool

		public init(refreshDate: Date, didFetch: Bool) {
			self.refreshDate = refreshDate
			self.didFetch = didFetch
		}
	}

	/// Bring this organization's snapshots up to date if there is any point, and
	/// say when to come back.
	///
	/// - Parameters:
	///   - organizationId: nil before the app has ever published — nothing to
	///     fetch for, and nothing to fetch with.
	///   - organizationName: from the widget's organization index, passed
	///     through so a fetched snapshot is named the same way a published one
	///     is.
	///   - storedGeneratedAt: the snapshot already on disk, so a widget woken
	///     moments after the app published does not re-fetch what it has.
	public static func run(
		organizationId: String?,
		organizationName: String?,
		storedGeneratedAt: Date?,
		now: Date = Date(),
		fetcher: WidgetSummaryFetcher = .shared,
		fetchStates: WidgetFetchStateStore = WidgetFetchStateStore()
	) async -> Outcome {
		guard let organizationId else {
			return Outcome(refreshDate: WidgetTimelineSchedule.refreshDate(from: now), didFetch: false)
		}

		let attempt = await fetcher.fetch(
			organizationId: organizationId,
			organizationName: organizationName,
			storedGeneratedAt: storedGeneratedAt,
			now: now
		)

		// Read *after* the attempt: the fetcher is what writes the failure count
		// this backoff is derived from.
		let state = fetchStates.load(organizationId: organizationId)
		let failures: Int
		switch attempt {
		// Nothing is wrong. A fetch that succeeded, a snapshot still inside the
		// freshness floor, and an attempt someone else is already making are all
		// the healthy interval — none of them should inherit a backoff from a
		// failure that has since been superseded.
		case .fetched, .fresh, .coalesced:
			failures = 0
		// The app has not covered this organization yet. It will, on its next
		// foreground, and it reloads the timeline when it does — so there is
		// nothing to back off from and no reason to hurry.
		case .noCredential:
			failures = 0
		// Expired or rejected. Only the app can mint a working replacement, and
		// it reloads the timeline when it has — so back all the way off rather
		// than spend the day's rebuilds on a credential that will answer 401 to
		// every one of them.
		case .needsApp:
			failures = Int.max
		case .failed:
			failures = state.consecutiveFailures
		}

		return Outcome(
			refreshDate: WidgetTimelineSchedule.refreshDate(from: now, consecutiveFailures: failures),
			didFetch: {
				if case .fetched = attempt { return true }
				return false
			}()
		)
	}
}
