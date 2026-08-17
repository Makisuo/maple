import MapleAPI
import SwiftUI

/// The four states every screen in this app can be in.
///
/// `empty` is separated from `loaded([])` on purpose: "No services reported in
/// the last 24 hours" is a fact about the time window, and rendering it as an
/// error — or as a blank list — is the difference between a screen that
/// explains itself and one that looks broken.
enum LoadState<Value> {
	case loading
	case empty
	case failed(MapleAPIError)
	case loaded(Value)

	var value: Value? {
		if case .loaded(let value) = self { return value }
		return nil
	}

	/// True once there is something on screen, so a refresh can leave it there
	/// instead of flashing a placeholder.
	var hasContent: Bool {
		switch self {
		case .loaded, .empty: true
		case .loading, .failed: false
		}
	}
}

/// Renders a `LoadState` uniformly.
struct LoadableView<Value, Content: View>: View {
	let state: LoadState<Value>
	let emptyTitle: String
	let emptyMessage: String
	var skeletonRowHeight: CGFloat = 64
	let retry: () -> Void
	@ViewBuilder let content: (Value) -> Content

	var body: some View {
		switch state {
		case .loading:
			// DESIGN.md: "Don't ship loading spinners by default." A skeleton
			// keeps the layout still, so arriving data doesn't shove the page.
			SkeletonList(rowHeight: skeletonRowHeight)

		case .empty:
			EmptyStateView(title: emptyTitle, message: emptyMessage)

		case .failed(let error):
			ErrorStateView(error: error, retry: retry)

		case .loaded(let value):
			content(value)
		}
	}
}

/// Placeholder rows that match the real row rhythm.
struct SkeletonList: View {
	var rowHeight: CGFloat = 64
	var rows: Int = 7

	@State private var shimmer = false

	var body: some View {
		VStack(spacing: 0) {
			ForEach(0..<rows, id: \.self) { index in
				VStack(alignment: .leading, spacing: 8) {
					RoundedRectangle(cornerRadius: Token.Radius.sm)
						.fill(Token.muted)
						.frame(width: 120 + CGFloat((index * 37) % 90), height: 12)
					RoundedRectangle(cornerRadius: Token.Radius.sm)
						.fill(Token.muted.opacity(0.6))
						.frame(width: 190 + CGFloat((index * 53) % 70), height: 10)
				}
				.frame(maxWidth: .infinity, minHeight: rowHeight, alignment: .leading)
				.padding(.horizontal, 16)
				Hairline()
			}
			Spacer(minLength: 0)
		}
		.opacity(shimmer ? 0.55 : 1)
		.animation(
			.easeInOut(duration: 1.1).repeatForever(autoreverses: true),
			value: shimmer
		)
		.onAppear { shimmer = true }
		.accessibilityLabel("Loading")
	}
}

struct EmptyStateView: View {
	let title: String
	let message: String

	var body: some View {
		VStack(spacing: 10) {
			Text(title)
				.font(Typo.heading)
				.foregroundStyle(Token.foreground)
			Text(message)
				.font(Typo.small)
				.foregroundStyle(Token.mutedForeground)
				.multilineTextAlignment(.center)
		}
		.padding(.horizontal, 32)
		.frame(maxWidth: .infinity, maxHeight: .infinity)
	}
}

/// The error state, following `common/error-state.tsx`: a dashed panel, the
/// signature "dropped signal" glyph, then title and body.
struct ErrorStateView: View {
	let error: MapleAPIError
	let retry: () -> Void

	var body: some View {
		VStack(spacing: 16) {
			DroppedSignalGlyph()
				.frame(width: 72, height: 28)

			VStack(spacing: 6) {
				Text(error.title)
					.font(Typo.bodyMedium)
					.foregroundStyle(Token.foreground)
				Text(error.message)
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
					.multilineTextAlignment(.center)
			}

			// Offering "Try again" on a validation error would be a lie — the
			// same request fails the same way.
			if error.isRetryable {
				Button(action: retry) {
					Text("Try again")
						.font(Typo.smallMedium)
						.foregroundStyle(Token.foreground)
						.padding(.horizontal, 12)
						.frame(height: 28)
						.background(Token.muted, in: .rect(cornerRadius: Token.Radius.md))
				}
				.buttonStyle(.plain)
			}
		}
		.padding(24)
		.frame(maxWidth: .infinity)
		.background(
			RoundedRectangle(cornerRadius: Token.Radius.lg)
				.strokeBorder(Token.border, style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
		)
		.padding(16)
	}
}

/// A telemetry line that stops, with a pulsing break and a dashed trail.
/// Reproduced from the web's bespoke SVG — it is a signature element, and a
/// generic warning triangle would read as someone else's app.
struct DroppedSignalGlyph: View {
	@State private var pulsing = false

	var body: some View {
		Canvas { context, size in
			let midY = size.height / 2
			let breakX = size.width * 0.52

			var signal = Path()
			signal.move(to: CGPoint(x: 0, y: midY))
			signal.addLine(to: CGPoint(x: size.width * 0.14, y: midY))
			signal.addLine(to: CGPoint(x: size.width * 0.22, y: midY - size.height * 0.32))
			signal.addLine(to: CGPoint(x: size.width * 0.32, y: midY + size.height * 0.28))
			signal.addLine(to: CGPoint(x: size.width * 0.42, y: midY - size.height * 0.12))
			signal.addLine(to: CGPoint(x: breakX, y: midY))
			context.stroke(
				signal,
				with: .color(Token.mutedForeground),
				style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round)
			)

			var trail = Path()
			trail.move(to: CGPoint(x: breakX + 6, y: midY))
			trail.addLine(to: CGPoint(x: size.width, y: midY))
			context.stroke(
				trail,
				with: .color(Token.destructive),
				style: StrokeStyle(lineWidth: 1.5, lineCap: .round, dash: [3, 5])
			)

			let dot = CGRect(x: breakX - 2.5, y: midY - 2.5, width: 5, height: 5)
			context.fill(Path(ellipseIn: dot), with: .color(Token.destructive))
		}
		.opacity(pulsing ? 0.6 : 1)
		.animation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true), value: pulsing)
		.onAppear { pulsing = true }
		.accessibilityHidden(true)
	}
}
