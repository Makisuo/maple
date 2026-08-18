import MapleAPI
import SwiftUI

// MARK: - Badge

/// The badge/chip used throughout the product.
///
/// Issue rows override the default badge to `h-5 px-1.5 text-[10px]` — 20pt
/// tall, 10pt text, 6pt horizontal padding, 4pt radius. Those are the numbers
/// used here, because that is the density this app is built at.
struct MapleBadge: View {
	let text: String
	let tint: Color
	/// Fill opacity. The web convention is a /10 or /15 wash under
	/// full-strength text.
	var fillOpacity: Double = 0.12

	var body: some View {
		Text(text)
			.font(Typo.microMedium)
			.foregroundStyle(tint)
			.padding(.horizontal, 6)
			.frame(height: 20)
			.background(tint.opacity(fillOpacity), in: .rect(cornerRadius: Token.Radius.sm))
			.fixedSize()
	}
}

extension IssueSeverity {
	var label: String { rawValue.capitalized }

	/// Issue severity uses raw Tailwind palette colours rather than the
	/// `--severity-*` ramp. Mirrored from `severity-badge.tsx` as-is.
	var tint: Color {
		switch self {
		case .critical: Token.destructive
		case .high: Token.orangeText
		case .medium: Token.amberText
		case .low: Token.mutedForeground
		}
	}

	var fill: Color {
		switch self {
		case .critical: Token.destructive
		case .high: Token.orangeFill
		case .medium: Token.amberFill
		case .low: Token.muted
		}
	}
}

/// Severity chip. A null severity renders an em dash rather than a badge —
/// matching the web, which shows `—` in muted text.
struct SeverityBadge: View {
	let severity: IssueSeverity?

	var body: some View {
		if let severity {
			Text(severity.label)
				.font(Typo.microMedium)
				.foregroundStyle(severity.tint)
				.padding(.horizontal, 6)
				.frame(height: 20)
				.background(severity.fill.opacity(0.12), in: .rect(cornerRadius: Token.Radius.sm))
				.fixedSize()
		} else {
			Text("—")
				.font(Typo.small)
				.foregroundStyle(Token.mutedForeground.opacity(0.6))
		}
	}
}

extension WorkflowState {
	var label: String {
		switch self {
		case .triage: "Triage"
		case .todo: "Todo"
		case .inProgress: "In progress"
		case .inReview: "In review"
		case .done: "Done"
		case .cancelled: "Cancelled"
		case .wontfix: "Wontfix"
		}
	}

	/// From `workflow-badge.tsx`.
	var tint: Color {
		switch self {
		case .triage: Token.amberText
		case .inProgress: Token.blueText
		case .inReview: Token.purpleText
		case .done: Token.success
		case .todo, .cancelled, .wontfix: Token.mutedForeground
		}
	}

	var fill: Color {
		switch self {
		case .triage: Token.amberFill
		case .inProgress: Token.blueFill
		case .inReview: Token.purpleFill
		case .done: Token.success
		case .todo, .cancelled, .wontfix: Token.muted
		}
	}
}

struct WorkflowBadge: View {
	let state: WorkflowState

	var body: some View {
		MapleBadge(text: state.label, tint: state.tint)
			.background(state.fill.opacity(0.12), in: .rect(cornerRadius: Token.Radius.sm))
	}
}

// MARK: - Health

/// Service health, from `apps/web/src/components/dashboard/service-health.ts`.
enum ServiceHealth {
	case healthy
	case degraded
	case unhealthy

	/// Error rate ≥ 5% or p95 ≥ 3s is unhealthy; ≥ 1% or p95 ≥ 1s is degraded.
	init(errorRate: Double, p95LatencyMs: Double) {
		if errorRate >= 0.05 || p95LatencyMs >= 3000 {
			self = .unhealthy
		} else if errorRate >= 0.01 || p95LatencyMs >= 1000 {
			self = .degraded
		} else {
			self = .healthy
		}
	}

	var tint: Color {
		switch self {
		case .healthy: Token.success
		case .degraded: Token.severityWarn
		case .unhealthy: Token.destructive
		}
	}
}

/// Renders for degraded and unhealthy only. Healthy rows stay unadorned — the
/// absence of a mark is the signal, so a column of green dots never appears.
struct HealthDot: View {
	let health: ServiceHealth

	var body: some View {
		if health != .healthy {
			Circle()
				.fill(health.tint)
				.frame(width: 6, height: 6)
				.accessibilityLabel(health == .unhealthy ? "Unhealthy" : "Degraded")
		}
	}
}

// MARK: - Tone rules

enum Tone {
	/// The breaks are `ServiceHealth`'s, not the web's `errorRateToneClass`.
	///
	/// The web warns on anything above zero, which on a phone-width list put an
	/// amber number on six of nine rows — including services with no health dot,
	/// so the two marks on one row disagreed about whether it was fine. Amber
	/// costs more here (`DESIGN.md`: at most one per screen), so the tone follows
	/// the same 1% / 5% breaks the dot does and a row now reads one way.
	static func errorRate(_ ratio: Double) -> Color {
		if ratio >= 0.05 { return Token.severityError }
		if ratio >= 0.01 { return Token.severityWarn }
		return Token.mutedForeground
	}

	/// `packages/ui/src/lib/latency-tone.ts` — a budget per percentile, then
	/// ratio breaks at 0.15 / 0.5 / 1 / 3.
	static func latency(_ ms: Double, scale: LatencyScale) -> Color {
		guard ms.isFinite, ms > 0 else { return Token.mutedForeground }
		let ratio = ms / scale.budget
		switch ratio {
		case ..<0.15: return Token.mutedForeground
		case ..<0.5: return Token.foreground.opacity(0.7)
		case ..<1: return Token.foreground
		case ..<3: return Token.severityWarn
		default: return Token.severityError
		}
	}

	enum LatencyScale {
		case p50, p95, p99

		var budget: Double {
			switch self {
			case .p50: 300
			case .p95: 1000
			case .p99: 2000
			}
		}
	}
}

// MARK: - Layout primitives

/// A 1px (physical-pixel) rule. DESIGN.md bans borders of 2px or more; depth
/// comes from tonal steps, not from weight or shadow.
struct Hairline: View {
	var body: some View {
		Rectangle()
			.fill(Token.border)
			.frame(height: Token.hairline)
	}
}

/// The uppercase section heading:
/// `text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground`.
struct SectionLabel: View {
	let text: String

	init(_ text: String) { self.text = text }

	var body: some View {
		Text(text)
			.sectionLabelStyle()
	}
}

/// A stat tile, following `AlertStatStrip`: hairline-separated cells built from
/// a `bg-border` backplate showing through 1px gaps, uppercase eyebrow, large
/// tabular value.
struct StatTile: View {
	let label: String
	let value: String
	var tint: Color = Token.foreground

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			Text(label)
				.sectionLabelStyle()
				.lineLimit(1)
			Text(value)
				.font(Typo.statValue)
				.tabularNumbers()
				.foregroundStyle(tint)
				.lineLimit(1)
				.minimumScaleFactor(0.7)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(.horizontal, 16)
		.padding(.vertical, 14)
		.background(Token.card)
	}
}

/// A grid of stat tiles separated by hairlines, produced the way the web does
/// it — a border-coloured backplate with 1px gaps — rather than by drawing
/// dividers.
struct StatGrid<Content: View>: View {
	let columns: Int
	@ViewBuilder let content: Content

	var body: some View {
		LazyVGrid(
			columns: Array(repeating: GridItem(.flexible(), spacing: Token.hairline), count: columns),
			spacing: Token.hairline
		) {
			content
		}
		.background(Token.border)
		.clipShape(.rect(cornerRadius: Token.Radius.lg))
		.overlay(
			RoundedRectangle(cornerRadius: Token.Radius.lg)
				.stroke(Token.border, lineWidth: Token.hairline)
		)
	}
}

/// A label/value row, from `detail-rail.tsx`: fixed label column, value pushed
/// right, hairline underneath.
struct DetailRow<Value: View>: View {
	let label: String
	@ViewBuilder let value: Value

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: 12) {
			Text(label)
				.font(Typo.small)
				.foregroundStyle(Token.mutedForeground)
			Spacer(minLength: 8)
			value
				.font(Typo.small)
				.foregroundStyle(Token.foreground)
				.multilineTextAlignment(.trailing)
		}
		.frame(minHeight: 32)
	}
}

extension DetailRow where Value == Text {
	init(_ label: String, _ text: String) {
		self.init(label: label) { Text(text) }
	}
}
