import SwiftUI

/// The one line of feedback shown when opening a destination moved the user to
/// another organization — or refused to.
///
/// An overlay on the tab view rather than anything inside a `NavigationStack`:
/// answering a cross-organization tap changes the tab *and* replaces the stack,
/// so anything living in a stack would be torn down in the same frame it
/// appeared. And not an alert — someone who tapped an alert to read it should
/// not have to dismiss a question first.
struct OrganizationNoticeView: View {
	let notice: DestinationOpener.Notice
	let onDismiss: () -> Void

	/// Long enough to read six words, short enough that it is gone before the
	/// incident has finished loading.
	private static let duration: Duration = .seconds(3)

	var body: some View {
		HStack(spacing: 8) {
			switch notice.kind {
			case .switched(let organizationId, let name):
				// The same categorical colour the switcher and the picker rows
				// use, so the toast and the toolbar are recognisably one thing.
				ServiceDot(serviceName: organizationId, size: 7)
				Text("Switched to \(name ?? "another organization")")
					.font(Typo.smallMedium)
					.foregroundStyle(Token.foreground)
			case .notAMember:
				Circle()
					.fill(Token.destructive)
					.frame(width: 7, height: 7)
				Text("You're not a member of that organization")
					.font(Typo.smallMedium)
					.foregroundStyle(Token.foreground)
			}
		}
		.padding(.horizontal, 12)
		.padding(.vertical, 8)
		.background(
			RoundedRectangle(cornerRadius: Token.Radius.xl, style: .continuous)
				.fill(Token.card)
				.stroke(Token.border, lineWidth: 1)
		)
		.shadow(color: .black.opacity(0.12), radius: 12, y: 4)
		.padding(.top, 8)
		.accessibilityElement(children: .combine)
		.task(id: notice.id) {
			try? await Task.sleep(for: Self.duration)
			guard !Task.isCancelled else { return }
			onDismiss()
		}
	}
}
