import SwiftUI
import UIKit

/// Teaches UIKit's navigation bar Maple's typeface.
///
/// The three root tabs use large titles, which is the strongest structural
/// signal that an app is native: the title sits left, collapses to inline as you
/// scroll, and the system owns the transition. What we do *not* want from the
/// system is San Francisco — so this replaces the fonts and leaves every other
/// behaviour alone.
///
/// This is `UINavigationBarAppearance` rather than a SwiftUI modifier because
/// SwiftUI has no API for the large-title font. Colours stay unset: the bar is
/// transparent over `Token.background`, and the app is dark-only.
enum NavigationAppearance {
	/// Large-title face at the system's own size, so the collapse animation
	/// still lands where UIKit expects it to.
	private static let largeTitleSize: CGFloat = 30
	private static let inlineTitleSize: CGFloat = 16

	@MainActor
	static func apply() {
		let appearance = UINavigationBarAppearance()
		appearance.configureWithTransparentBackground()

		if let large = UIFont(name: "Geist-SemiBold", size: largeTitleSize) {
			appearance.largeTitleTextAttributes = [
				.font: large,
				.foregroundColor: UIColor(Token.foreground),
			]
		}
		// Inline is the collapsed state of the same title, and collapsed titles
		// sit next to mono content — so this one is Geist Mono, matching the
		// `Typo.monoTitle` the detail screens already use.
		if let inline = UIFont(name: "GeistMono-SemiBold", size: inlineTitleSize) {
			appearance.titleTextAttributes = [
				.font: inline,
				.foregroundColor: UIColor(Token.foreground),
			]
		}

		UINavigationBar.appearance().standardAppearance = appearance
		UINavigationBar.appearance().compactAppearance = appearance
		UINavigationBar.appearance().scrollEdgeAppearance = appearance
	}
}
