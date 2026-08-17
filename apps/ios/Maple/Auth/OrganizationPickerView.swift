import ClerkKit
import SwiftUI

/// Chooses the organization whose data the app will show.
///
/// This is not optional chrome. The v2 API has no org header and rejects a
/// token with no active-organization claim, so the app is unusable until one is
/// selected. `SessionController.refresh()` auto-selects when the user belongs
/// to exactly one, so this screen only appears for a genuine choice — or for
/// the empty case, which is a dead end worth explaining.
struct OrganizationPickerView: View {
	@Environment(SessionController.self) private var session
	@State private var isSwitching = false

	var body: some View {
		NavigationStack {
			ZStack {
				Token.background.ignoresSafeArea()

				if session.memberships.isEmpty {
					noMemberships
				} else {
					picker
				}
			}
			.navigationTitle("Organization")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				if !session.memberships.isEmpty {
					ToolbarItem(placement: .topBarTrailing) {
						Button {
							Task { await session.signOut() }
						} label: {
							Text("Sign out")
								.font(Typo.smallMedium)
								.foregroundStyle(Token.mutedForeground)
						}
					}
				}
			}
		}
		.tint(Token.primary)
	}

	private var picker: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 0) {
				SectionLabel("Choose an organization")
					.padding(.horizontal, 16)
					.padding(.top, 8)
					.padding(.bottom, 12)

				ForEach(session.memberships, id: \.id) { membership in
					Button {
						isSwitching = true
						Task {
							await session.select(organizationId: membership.organization.id)
							isSwitching = false
						}
					} label: {
						OrganizationRow(membership: membership)
					}
					.buttonStyle(RowButtonStyle())
					.disabled(isSwitching)
					Hairline()
				}

				if let error = session.organizationError {
					Text(error)
						.font(Typo.small)
						.foregroundStyle(Token.destructive)
						.padding(16)
				}
			}
		}
		.scrollContentBackground(.hidden)
		.disabled(isSwitching)
		.opacity(isSwitching ? 0.5 : 1)
	}

	private var noMemberships: some View {
		VStack(spacing: 16) {
			EmptyStateView(
				title: "No organizations",
				message:
					"This account isn't a member of any Maple organization yet. Ask an admin to invite you, then sign in again."
			)
			Button {
				Task { await session.signOut() }
			} label: {
				Text("Sign out")
					.font(Typo.smallMedium)
					.foregroundStyle(Token.foreground)
					.padding(.horizontal, 14)
					.frame(height: 32)
					.background(Token.muted, in: .rect(cornerRadius: Token.Radius.md))
			}
			.buttonStyle(.plain)
		}
	}
}

private struct OrganizationRow: View {
	let membership: OrganizationMembership

	var body: some View {
		HStack(spacing: 10) {
			// Organizations get the same categorical colour treatment services
			// do, so the mark is meaningful rather than decorative.
			ServiceDot(serviceName: membership.organization.id, size: 10)

			VStack(alignment: .leading, spacing: 3) {
				Text(membership.organization.name)
					.font(Typo.bodyMedium)
					.foregroundStyle(Token.foreground)
					.lineLimit(1)
				Text(membership.role.replacingOccurrences(of: "org:", with: "").capitalized)
					.font(Typo.tiny)
					.foregroundStyle(Token.mutedForeground)
			}

			Spacer()

			Image(systemName: "chevron.right")
				.font(.system(size: 11, weight: .semibold))
				.foregroundStyle(Token.mutedForeground.opacity(0.6))
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 14)
		.contentShape(.rect)
	}
}
