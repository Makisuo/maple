import SwiftUI

/// Maple's design tokens, ported verbatim from `packages/ui/src/styles/tokens.css`.
///
/// The values are kept in OKLCH — the same numbers that appear in the CSS — and
/// converted at runtime rather than pre-baked into RGB. That way a token can be
/// diffed against the stylesheet by eye, which is the whole point of having one
/// source of truth. The conversion is exact (Oklab → linear sRGB → sRGB), not an
/// approximation.
///
/// Note the neutrals differ in temperature between themes: light is cool
/// (hue ~286), dark is warm (hue ~67–75). The amber primary (hue 59) is the one
/// constant. Do not "fix" that — it is deliberate.
enum Token {
	// MARK: Core surfaces

	static let background = theme(light: .init(1, 0, 0), dark: .init(0.207, 0.008, 67))
	static let foreground = theme(light: .init(0.141, 0.005, 285.823), dark: .init(0.91, 0.016, 74))
	static let card = theme(light: .init(1, 0, 0), dark: .init(0.224, 0.009, 75))
	static let cardForeground = foreground
	static let muted = theme(light: .init(0.967, 0.001, 286.375), dark: .init(0.26, 0.012, 67))
	static let mutedForeground = theme(light: .init(0.552, 0.016, 285.938), dark: .init(0.603, 0.023, 72))
	static let border = theme(light: .init(0.92, 0.004, 286.32), dark: .init(0.268, 0.012, 67))
	static let input = theme(light: .init(0.92, 0.004, 286.32), dark: .init(0.33, 0.015, 72))
	static let ring = theme(light: .init(0.705, 0.015, 286.067), dark: .init(0.58, 0.02, 65))

	/// The brand amber. DESIGN.md: it appears **once per screen** — resist
	/// spraying it across every accent.
	static let primary = theme(light: .init(0.66, 0.16, 59), dark: .init(0.714, 0.154, 59))
	static let primaryForeground = theme(light: .init(0.21, 0.008, 67), dark: .init(0.207, 0.008, 67))
	static let destructive = theme(light: .init(0.577, 0.245, 27.325), dark: .init(0.654, 0.176, 30))

	// MARK: Semantic aliases (Tailwind palette in the stylesheet)

	static let success = constant(.init(0.696, 0.17, 162.48)) // emerald-500
	static let warning = constant(.init(0.769, 0.188, 70.08)) // amber-500

	// MARK: Severity ramp

	static let severityWarn = theme(light: .init(0.769, 0.188, 70.08), dark: .init(0.714, 0.154, 59))
	static let severityError = theme(light: .init(0.637, 0.237, 25.331), dark: .init(0.654, 0.176, 30))

	// MARK: Issue-severity tones
	//
	// These deliberately use raw Tailwind palette colours rather than the
	// severity ramp above. That is an inconsistency in the web app, but the
	// point here is pixel parity with what shipped, not tidiness.

	static let orangeText = theme(light: .init(0.646, 0.222, 41.116), dark: .init(0.75, 0.183, 55.934))
	static let orangeFill = constant(.init(0.705, 0.213, 47.604)) // orange-500
	static let amberText = theme(light: .init(0.666, 0.179, 58.318), dark: .init(0.828, 0.189, 84.429))
	static let amberFill = constant(.init(0.769, 0.188, 70.08)) // amber-500
	static let blueText = theme(light: .init(0.546, 0.245, 262.881), dark: .init(0.707, 0.165, 254.624))
	static let blueFill = constant(.init(0.623, 0.214, 259.815)) // blue-500
	static let purpleText = theme(light: .init(0.558, 0.288, 302.321), dark: .init(0.714, 0.203, 305.504))
	static let purpleFill = constant(.init(0.606, 0.25, 292.717)) // violet-500
	static let tealText = theme(light: .init(0.6, 0.118, 184.704), dark: .init(0.777, 0.152, 181.912))
	static let tealFill = constant(.init(0.704, 0.14, 182.503)) // teal-500

	// MARK: Chart palette (percentile-specific — not the generic 1..5 ramp)

	static let chartP50 = theme(light: .init(0.62, 0.14, 250), dark: .init(0.693, 0.165, 254))
	static let chartP95 = theme(light: .init(0.62, 0.17, 65), dark: .init(0.714, 0.154, 59))
	static let chartP99 = theme(light: .init(0.55, 0.2, 30), dark: .init(0.654, 0.176, 30))
	static let chartError = theme(light: .init(0.577, 0.245, 27.325), dark: .init(0.62, 0.225, 22))

	// MARK: Radii — `--radius: 8px` and its Tailwind-derived scale

	enum Radius {
		static let sm: CGFloat = 4 // chips and badges
		static let md: CGFloat = 6 // inputs, list containers
		static let lg: CGFloat = 8
		static let xl: CGFloat = 12
		static let xxl: CGFloat = 16 // cards
	}

	/// `--border-hairline`, which halves on retina in the stylesheet. On iOS the
	/// equivalent is one physical pixel.
	@MainActor static var hairline: CGFloat { 1 / max(UIScreen.main.scale, 1) }

	// MARK: - OKLCH

	/// An OKLCH triple exactly as written in `tokens.css`: lightness 0–1, chroma,
	/// hue in degrees.
	struct OKLCH {
		let l: Double
		let c: Double
		let h: Double

		init(_ l: Double, _ c: Double, _ h: Double) {
			self.l = l
			self.c = c
			self.h = h
		}
	}

	/// A token that resolves differently per colour scheme.
	static func theme(light: OKLCH, dark: OKLCH) -> Color {
		Color(UIColor { traits in
			UIColor(traits.userInterfaceStyle == .dark ? dark.color : light.color)
		})
	}

	/// A token with one value in both themes.
	static func constant(_ value: OKLCH) -> Color { value.color }
}

extension Token.OKLCH {
	/// Exact OKLCH → sRGB. Mirrors the CSS Color 4 conversion so a token here and
	/// the same token in the browser render identically.
	var color: Color {
		let hueRadians = h * .pi / 180
		let a = c * cos(hueRadians)
		let b = c * sin(hueRadians)

		// Oklab → LMS
		let lCone = l + 0.3963377774 * a + 0.2158037573 * b
		let mCone = l - 0.1055613458 * a - 0.0638541728 * b
		let sCone = l - 0.0894841775 * a - 1.2914855480 * b

		let lLinear = lCone * lCone * lCone
		let mLinear = mCone * mCone * mCone
		let sLinear = sCone * sCone * sCone

		// LMS → linear sRGB
		let red = 4.0767416621 * lLinear - 3.3077115913 * mLinear + 0.2309699292 * sLinear
		let green = -1.2684380046 * lLinear + 2.6097574011 * mLinear - 0.3413193965 * sLinear
		let blue = -0.0041960863 * lLinear - 0.7034186147 * mLinear + 1.7076147010 * sLinear

		return Color(
			.sRGB,
			red: Self.encodeGamma(red),
			green: Self.encodeGamma(green),
			blue: Self.encodeGamma(blue),
			opacity: 1
		)
	}

	/// Linear → gamma-encoded sRGB, clamped into gamut.
	private static func encodeGamma(_ value: Double) -> Double {
		let encoded =
			value <= 0.0031308
			? 12.92 * value
			: 1.055 * pow(max(value, 0), 1 / 2.4) - 0.055
		return min(max(encoded, 0), 1)
	}
}
