import Foundation

/// "Would the widget draw the same thing?", for deciding whether a refresh has
/// earned a `WidgetCenter` reload.
///
/// iOS meters widget reloads, and the app's own `reloadTimelines` calls come out
/// of the same budget as the timeline rebuilds that keep the widget alive when
/// the app is closed. So a round that fetched and found nothing new must not
/// spend one: every wasted reload is one that is not available later for the
/// round that would have shown a new critical.
///
/// **Equality is the wrong test.** Both snapshots carry fields that move on
/// every single fetch without changing a glyph on screen — `generatedAt`
/// obviously, but also `WidgetIssue.lastSeenAt` (seconds), `occurrenceCount`
/// (still renders "41.2K"), and `ServiceThroughput.points` (a sliding window,
/// so every bucket shifts). `!=` would report "changed" every round and buy
/// nothing at all.
///
/// So conformers project themselves through the very same `WidgetFormat` /
/// `WidgetTime` functions the views call. "Changed" then means literally "a
/// reader could see a difference", and the rule cannot drift away from what the
/// views do without a test noticing.
public protocol WidgetSnapshotContent {
	/// Everything this snapshot can put on screen, and nothing else.
	///
	/// A `String` rather than a hash: `hashValue` is seeded per process, so it
	/// is not comparable across the app-and-extension boundary or across
	/// launches — and this one can be read in a debugger.
	var contentFingerprint: String { get }
}

/// Whether a freshly fetched snapshot has earned a reload.
///
/// Deliberately date-free: staleness is passed in rather than computed, so the
/// whole rule is a pure function of two snapshots and a bool.
public enum WidgetReloadDecision {
	public static func shouldReload(
		stored: (any WidgetSnapshotContent)?,
		incoming: any WidgetSnapshotContent,
		storedIsStale: Bool
	) -> Bool {
		// Nothing on screen yet, or nothing readable: anything is an improvement.
		guard let stored else { return true }
		if stored.contentFingerprint != incoming.contentFingerprint { return true }
		// Identical content, but what is on screen is dimmed and captioned
		// "updated 2h ago" — because suppressing a reload means the widget keeps
		// rendering the *old* `generatedAt` until its next timeline build. The
		// numbers have just been confirmed current, so say so. Bounded to one
		// reload per `staleAfter` per surface.
		return storedIsStale
	}
}

extension IssuesSnapshot: WidgetSnapshotContent {
	public var contentFingerprint: String {
		var parts: [String] = [
			organizationId,
			organizationName ?? "",
			// The headline, as rendered: the count and whether it reads "20+".
			"\(openCount)\(isCapped ? "+" : "")",
			"\(criticalCount)",
			"\(highCount)",
		]
		for issue in issues {
			parts.append(
				[
					issue.id,
					issue.title,
					issue.subtitle ?? "",
					issue.serviceName,
					issue.severity?.rawValue ?? "",
					// The abbreviated form the row shows, so 41 210 → 41 240
					// events is the same "41.2K" and costs no reload.
					WidgetTime.count(issue.occurrenceCount),
					// The relative label's own resolution below an hour. A row
					// that still says "12m" is not worth a redraw.
					"\(Int(issue.lastSeenAt.timeIntervalSince1970 / 60))",
					issue.isRegressed ? "regressed" : "",
					issue.hasOpenIncident ? "paging" : "",
				].joined(separator: "\u{1f}")
			)
		}
		return parts.joined(separator: "\n")
	}
}

extension ThroughputSnapshot: WidgetSnapshotContent {
	public var contentFingerprint: String {
		([organizationId, "\(windowMinutes)"] + ([overall] + services).map(\.renderedFields))
			.joined(separator: "\n")
	}
}

extension ServiceThroughput {
	/// Every string this row puts on screen.
	///
	/// `points` is excluded on purpose: an hour-long series scrolling by one
	/// bucket is invisible, and including it would make suppression a no-op on
	/// any org with traffic. `trend` *is* included, and it is derived from
	/// `points` — so a change in the shape that actually means something still
	/// earns a reload.
	var renderedFields: String {
		[
			displayName,
			WidgetFormat.rate(throughputPerSecond),
			WidgetFormat.errorRate(errorRate),
			WidgetFormat.latency(p95LatencyMs),
			WidgetFormat.trend(trend) ?? "",
		].joined(separator: "\u{1f}")
	}
}
