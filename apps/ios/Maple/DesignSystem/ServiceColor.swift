import SwiftUI

/// Deterministic per-service colour, ported from
/// `packages/ui/src/lib/colors.ts`.
///
/// The colour must match the web app exactly — the same service is meant to
/// carry the same hue in a browser tab and on a phone — so this reproduces the
/// JavaScript hash bit for bit, including its 32-bit signed overflow. Getting
/// the arithmetic "right" in Swift's terms would give different colours.
///
/// The result is theme-independent: identical value in light and dark.
///
/// DESIGN.md: service colour is **categorical only** — never sentiment, never
/// state — and must always appear beside the service name, since 16 hues are
/// indistinguishable under deuteranopia.
enum ServiceColor {
	private static let hues: [Double] = [
		250, 185, 155, 130, 90, 60, 45, 25, 0, 340, 320, 290, 270, 260, 210, 230,
	]

	private static let tiers: [(l: Double, c: Double)] = [
		(0.47, 0.17),
		(0.57, 0.15),
		(0.67, 0.12),
	]

	static func color(for serviceName: String) -> Color {
		let hash = hashString(serviceName)
		let hue = hues[hash % hues.count]
		let tier = tiers[(hash / hues.count) % tiers.count]
		return Token.OKLCH(tier.l, tier.c, hue).color
	}

	/// `hash = charCode + ((hash << 5) - hash)`, evaluated as int32 the way
	/// JavaScript's bitwise operators force it, then `Math.abs`.
	///
	/// Two details that matter: `charCodeAt` yields UTF-16 code units, so this
	/// iterates `.utf16` rather than unicode scalars; and `Int32.min` has no
	/// positive counterpart, so the magnitude is taken on a widened value.
	private static func hashString(_ value: String) -> Int {
		var hash: Int32 = 0
		for unit in value.utf16 {
			let shifted = Int64(hash) << 5
			let next = Int64(unit) &+ shifted &- Int64(hash)
			hash = Int32(truncatingIfNeeded: next)
		}
		return abs(Int(hash))
	}
}

/// The 8×8 mark that precedes a service name everywhere in the product.
///
/// It is a squircle, not a circle: the web uses `rounded-[35%]` with
/// `corner-shape: squircle`, and SwiftUI's `.continuous` rounding is the close
/// native equivalent.
struct ServiceDot: View {
	let serviceName: String
	var size: CGFloat = 8

	var body: some View {
		RoundedRectangle(cornerRadius: size * 0.35, style: .continuous)
			.fill(ServiceColor.color(for: serviceName))
			.frame(width: size, height: size)
			.accessibilityHidden(true)
	}
}
