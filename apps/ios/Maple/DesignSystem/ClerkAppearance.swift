import ClerkKitUI
import SwiftUI

/// Maple's palette and type scale, expressed as a `ClerkTheme`.
///
/// `AuthView` is Clerk's own SwiftUI surface, so it is the one screen the app
/// doesn't draw. Left alone it renders in system colours and San Francisco,
/// which makes sign-in look like a different product than everything behind it
/// — and it's the *first* screen a new user sees.
///
/// `ClerkTheme` takes semantic tokens rather than a stylesheet, and they line up
/// with `Token` closely enough that this is a mapping rather than a
/// reinterpretation. Where Clerk has no counterpart it derives one (borders and
/// pressed states come off the base colours), so only the bases are set here.
///
/// The one deliberate divergence from `Typo`: Clerk's scale is Dynamic
/// Type-relative and ours is fixed, so this uses `Fonts(fontFamily:)` and lets
/// Clerk keep its own sizes. Geist Mono at Clerk's proportions beats Geist Mono
/// forced into ours — a 17pt body in a sign-in form is right even though nothing
/// else in the app is larger than 14.
extension ClerkTheme {
	@MainActor static var maple: ClerkTheme {
		ClerkTheme(
			colors: Colors(
				primary: Token.primary,
				background: Token.background,
				input: Token.muted,
				danger: Token.destructive,
				success: Token.success,
				warning: Token.warning,
				foreground: Token.foreground,
				mutedForeground: Token.mutedForeground,
				primaryForeground: Token.primaryForeground,
				inputForeground: Token.foreground,
				neutral: Token.border,
				ring: Token.ring,
				muted: Token.muted,
				secondaryButtonBackground: Token.card,
				secondaryButtonForeground: Token.foreground,
				shadow: Token.border,
				border: Token.border
			),
			fonts: Fonts(fontFamily: Typo.bodyFamily),
			// `Token.Radius.md` — the radius inputs and list containers already
			// use, so the sign-in fields match the fields behind the gate.
			design: Design(borderRadius: Token.Radius.md)
		)
	}
}
