import Foundation
import MapleAPI
import Observation

/// Owns "which deployment environment is everything on screen scoped to".
///
/// The second scoping axis, after the organization, and deliberately shaped
/// like the first: one app-wide choice, a control next to the organization
/// switcher, and a change that invalidates every screen at once rather than
/// each screen growing its own filter.
///
/// It differs from the organization in one way that shapes everything here.
/// The organization travels in the session token, so every request carries it
/// whether the endpoint knows about it or not. An environment is a **query
/// parameter, per endpoint** — so the scope reaches the reads that declare one
/// and silently does not reach the rest. `MapleAPI` documents which is which;
/// the visible consequence is that alerts and service detail keep showing every
/// environment.
@MainActor
@Observable
final class EnvironmentController {
	/// Nil is "all environments" — a real choice, not a missing one, and the
	/// state every install starts in.
	private(set) var selected: String?
	/// What the organization has actually reported in, most recent window
	/// first. Empty until the first load, and after a failed one.
	private(set) var available: [String] = []

	/// Which organization `selected` and `available` belong to. Environments
	/// are an organization's facts, so both are meaningless without it — and
	/// carrying one organization's choice into another is the bug this exists
	/// to make impossible.
	private(set) var organizationId: String?

	/// A day, matching what the Services tab defaults to. Wide enough that an
	/// environment which was quiet this hour still appears, narrow enough that
	/// one decommissioned last month does not.
	private static let window = TimeWindow.last24Hours

	private let defaults: UserDefaults

	init(defaults: UserDefaults = .standard) {
		self.defaults = defaults
	}

	/// Per organization, never global. A single key would carry "staging" into
	/// an organization that has no such environment, where it filters every
	/// screen to nothing and looks like an outage.
	private static func key(for organizationId: String) -> String {
		"environment.selected.v1.\(organizationId)"
	}

	/// Whether the control is worth showing. One environment is not a choice —
	/// same rule as the organization switcher, which hides itself for an
	/// account with a single organization.
	var canSwitch: Bool { available.count > 1 }

	/// Adopt an organization: restore its stored choice, then load its
	/// environments.
	///
	/// Called with the same `dataGeneration` key the screens use, so an
	/// organization switch re-runs it and the picker never offers the previous
	/// organization's environments.
	func load(organizationId: String, api: any MapleAPI) async {
		if self.organizationId != organizationId {
			self.organizationId = organizationId
			// Restored before the fetch so a screen that builds after this point
			// gets the stored value first time and never fetches twice. It is
			// not relied on: `.task` ordering between this and the screens is
			// not guaranteed, and the stale-value clear below cannot happen
			// before the network answers anyway. Both are safe because
			// `selected` is part of `SessionController.DataScope`, so a screen
			// that built against the wrong value rebuilds when it changes.
			selected = defaults.string(forKey: Self.key(for: organizationId))
			available = []
		}

		let environments = (try? await api.environments(window: Self.window.resolve())) ?? []
		// A failed load leaves `available` empty, which hides the control. The
		// alternative — an empty menu the user can open — reads as "this
		// organization has no environments", which is a different claim and
		// usually a false one.
		guard !environments.isEmpty else { return }
		available = environments

		// A stored choice the organization no longer has would filter every
		// screen to nothing. Fall back to all environments rather than leaving
		// the app showing empty lists it cannot explain.
		if let selected, !environments.contains(selected) {
			self.selected = nil
			defaults.removeObject(forKey: Self.key(for: organizationId))
		}

		publishToWidgets()
	}

	/// Change the selection. Every screen reloads against it as a consequence,
	/// not as something this method arranges.
	///
	/// `selected` is half of `SessionController.DataScope`, which is what the
	/// screens key `.task(id:)` on — so writing it here is the whole
	/// notification. That is also why this does *not* bump `dataGeneration`:
	/// doing both would drag the detail screens, which are unfiltered, through
	/// a refetch that could not change what they show.
	func select(_ environment: String?) {
		guard environment != selected, let organizationId else { return }
		selected = environment

		if let environment {
			defaults.set(environment, forKey: Self.key(for: organizationId))
		} else {
			defaults.removeObject(forKey: Self.key(for: organizationId))
		}

		Telemetry.track(
			Telemetry.Event.environmentChanged,
			["organization.id": organizationId, "environment": environment ?? "all"]
		)
		publishToWidgets()
	}

	/// Tell the widget extension what the app knows.
	///
	/// It has no session and cannot ask, so the App Group index is the only
	/// place a widget's environment picker can get its options — and the only
	/// way a newly placed widget can land on what the user is already looking
	/// at instead of on a question.
	private func publishToWidgets() {
		guard let organizationId else { return }
		WidgetPublisher.shared.recordEnvironments(
			available,
			selected: selected,
			for: organizationId
		)
	}
}
