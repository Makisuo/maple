import SwiftUI

/// A 1px line with no axes, ticks, or dots — the "shape of the last hour" that
/// sits beside a number. Nil-safe: an empty or single-point series draws a
/// flat baseline rather than nothing, so a row never changes height when data
/// hasn't arrived.
struct Sparkline: View {
	let values: [Double]
	var tint: Color = Token.mutedForeground
	/// A horizontal reference (the alert threshold) in the same units as
	/// `values`. Drawn as a dashed hairline.
	var reference: Double? = nil
	var fills: Bool = true
	/// Whether the vertical range is anchored to zero.
	///
	/// True everywhere a sparkline sits beside a rate or a count, so a series
	/// wobbling between 4.9% and 5.1% does not look like a cliff. False on the
	/// incident Live Activity, where the baseline that means something is the
	/// threshold — the reader already knows the value breached it, and the
	/// question is how far and which way it is moving. Zero-anchored, a 2%→9%
	/// climb reads as a flat line at 26pt tall, which is the opposite of true.
	var anchorsToZero: Bool = true

	var body: some View {
		Canvas { context, size in
			let points = values.filter(\.isFinite)
			guard points.count >= 2 else {
				var flat = Path()
				flat.move(to: CGPoint(x: 0, y: size.height - 0.5))
				flat.addLine(to: CGPoint(x: size.width, y: size.height - 0.5))
				context.stroke(flat, with: .color(tint.opacity(0.35)), lineWidth: 1)
				return
			}

			var low = points.min() ?? 0
			var high = points.max() ?? 1
			if let reference {
				low = min(low, reference)
				high = max(high, reference)
			}
			if anchorsToZero { low = min(low, 0) }
			if high == low { high = low + 1 }

			let inset: CGFloat = 1
			let usableHeight = size.height - inset * 2
			func y(_ value: Double) -> CGFloat {
				inset + usableHeight * CGFloat(1 - (value - low) / (high - low))
			}
			let step = size.width / CGFloat(points.count - 1)

			var line = Path()
			for (index, value) in points.enumerated() {
				let point = CGPoint(x: CGFloat(index) * step, y: y(value))
				if index == 0 { line.move(to: point) } else { line.addLine(to: point) }
			}

			if fills {
				var area = line
				area.addLine(to: CGPoint(x: size.width, y: size.height))
				area.addLine(to: CGPoint(x: 0, y: size.height))
				area.closeSubpath()
				context.fill(
					area,
					with: .linearGradient(
						Gradient(colors: [tint.opacity(0.18), tint.opacity(0)]),
						startPoint: .zero,
						endPoint: CGPoint(x: 0, y: size.height)
					)
				)
			}

			context.stroke(line, with: .color(tint), style: StrokeStyle(lineWidth: 1, lineJoin: .round))

			if let reference {
				var rule = Path()
				let ry = y(reference)
				rule.move(to: CGPoint(x: 0, y: ry))
				rule.addLine(to: CGPoint(x: size.width, y: ry))
				context.stroke(
					rule,
					with: .color(Token.mutedForeground.opacity(0.7)),
					style: StrokeStyle(lineWidth: 1, dash: [2, 3])
				)
			}
		}
		.accessibilityHidden(true)
	}
}
