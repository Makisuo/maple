import SwiftUI

/// The deployment-environment control, next to the organization switcher.
///
/// The two sit together because they are the same kind of thing: the context
/// everything on screen is scoped to. Neither belongs in the title slot — iOS
/// puts the screen's *name* there — so both are leading items, with the
/// organization first because it is the wider scope.
///
/// It renders as a compact chip rather than a second name-and-chevron. The
/// switcher next to it already caps itself at 160pt precisely so the trailing
/// toolbar item survives on a small device; a second full-width control there
/// would spend that headroom and push the time-window menu off the bar.
///
/// Hidden when the organization reports fewer than two environments, for the
/// same reason the switcher hides itself for a single-organization account: a
/// control with one option is not a choice, and the screen's own title already
/// says where you are.
struct EnvironmentPickerView: View {
	@Environment(EnvironmentController.self) private var environments

	var body: some View {
		if environments.canSwitch {
			Menu {
				Picker("Environment", selection: selection) {
					// The whole organization, and the state an install starts
					// in. First so it is where the thumb lands when backing out
					// of a filter.
					Text("All environments").tag(String?.none)
					ForEach(environments.available, id: \.self) { environment in
						Text(environment).tag(String?.some(environment))
					}
				}
			} label: {
				HStack(spacing: 4) {
					Image(systemName: "line.3.horizontal.decrease")
						.font(.system(size: 9, weight: .semibold))
						.foregroundStyle(
							environments.selected == nil ? Token.mutedForeground : Token.foreground
						)
					// Only the chosen environment is named. "All environments"
					// spelled out would be the widest label on the bar for the
					// state that is not filtering anything.
					if let selected = environments.selected {
						Text(selected)
							.font(Typo.smallMedium)
							.foregroundStyle(Token.foreground)
							.lineLimit(1)
							.truncationMode(.tail)
					}
				}
				.frame(maxWidth: 110, alignment: .leading)
			}
			.accessibilityLabel("Filter by environment")
			.accessibilityValue(environments.selected ?? "All environments")
		}
	}

	/// Writes through the controller rather than binding to its property: the
	/// selection has to be persisted and published to the widgets, and a plain
	/// binding would set the value and do neither.
	private var selection: Binding<String?> {
		Binding(
			get: { environments.selected },
			set: { environments.select($0) }
		)
	}
}
