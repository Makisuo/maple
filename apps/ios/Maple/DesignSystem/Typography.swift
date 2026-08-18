import SwiftUI

/// Maple's type system.
///
/// The defining choice, straight from `tokens.css`: **`--font-sans` is Geist
/// Mono**. The whole product is monospace — tables, lists, labels, buttons.
/// Proportional Geist is reserved for `--font-display`, i.e. page titles and
/// empty-state headings, and nothing else. Inverting that inversion is the
/// fastest way to make this stop looking like Maple.
///
/// Sizes come from the Tailwind scale the web app uses: xs 12 / sm 14 /
/// base 16 / lg 18 / xl 20 / 3xl 30.
enum Typo {
	private enum Face {
		static let display = "Geist-SemiBold"
		static let mono = "GeistMono-Regular"
		static let monoMedium = "GeistMono-Medium"
		static let monoSemibold = "GeistMono-SemiBold"
	}

	/// Page titles. `font-display text-3xl font-semibold tracking-tight`.
	static let pageTitle = Font.custom(Face.display, size: 28).leading(.tight)
	/// Empty-state and card headings.
	static let heading = Font.custom(Face.display, size: 17)
	/// A prominent identifier — an exception type, a service name in a header.
	/// Mono, because it is a symbol rather than prose.
	static let monoTitle = Font.custom(Face.monoSemibold, size: 16)

	/// Body / row titles — `text-sm`.
	static let body = Font.custom(Face.mono, size: 14)
	static let bodyMedium = Font.custom(Face.monoMedium, size: 14)
	/// `text-xs` secondary metadata.
	static let small = Font.custom(Face.mono, size: 12)
	static let smallMedium = Font.custom(Face.monoMedium, size: 12)
	static let smallSemibold = Font.custom(Face.monoSemibold, size: 12)
	/// `text-[11px]` tertiary metadata.
	static let tiny = Font.custom(Face.mono, size: 11)
	static let tinyMedium = Font.custom(Face.monoMedium, size: 11)
	/// `text-[10px]` — badges and the uppercase section-label idiom.
	static let micro = Font.custom(Face.mono, size: 10)
	static let microMedium = Font.custom(Face.monoMedium, size: 10)

	/// The big number on a stat tile: `font-mono text-[26px] font-semibold`.
	static let statValue = Font.custom(Face.monoSemibold, size: 24)
	/// Tab bar and other chrome that should still read as Maple.
	static let chrome = Font.custom(Face.monoMedium, size: 11)

	/// The body family, by name, for the one consumer that builds its own scale
	/// rather than picking from this one: `ClerkTheme.Fonts(fontFamily:)`, whose
	/// sizes are Dynamic Type-relative. `Face` stays private — a family name is
	/// the only part of it anything outside this file should need.
	static let bodyFamily = Face.mono

	/// Registers the bundled faces. Fonts declared in Info.plist's `UIAppFonts`
	/// are registered automatically; this only reports a mismatch, which is
	/// otherwise invisible — SwiftUI silently falls back to the system font and
	/// the app just looks subtly wrong.
	@MainActor
	static func assertAvailable() {
		#if DEBUG
			for name in [Face.display, Face.mono, Face.monoMedium, Face.monoSemibold] {
				if UIFont(name: name, size: 12) == nil {
					assertionFailure(
						"Font '\(name)' is missing. Check UIAppFonts in project.yml and that the "
							+ "TTF is in Maple/Resources/Fonts."
					)
				}
			}
		#endif
	}
}

extension View {
	/// The uppercase section-label idiom:
	/// `text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground`.
	/// This is the *only* uppercase treatment in the system — everything else is
	/// sentence case.
	func sectionLabelStyle() -> some View {
		font(Typo.microMedium)
			.textCase(.uppercase)
			.tracking(1.2)
			.foregroundStyle(Token.mutedForeground)
	}

	/// Every count, percentile, percentage, duration, and relative time.
	/// DESIGN.md calls this "The Tabular-Numerals Rule" and it is applied even
	/// though Geist Mono is already fixed-width.
	func tabularNumbers() -> some View {
		monospacedDigit()
	}
}
