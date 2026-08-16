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
			Group {
				if session.memberships.isEmpty {
					ContentUnavailableView {
						Label("No organizations", systemImage: "building.2")
					} description: {
						Text(
							"Your account isn't a member of any Maple organization yet. Ask an admin to invite you, then sign in again."
						)
					} actions: {
						Button("Sign out") {
							Task { await session.signOut() }
						}
					}
				} else {
					List {
						Section {
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
								.disabled(isSwitching)
							}
						} footer: {
							if let error = session.organizationError {
								Text(error).foregroundStyle(.red)
							}
						}
					}
				}
			}
			.navigationTitle("Choose organization")
			.toolbar {
				if !session.memberships.isEmpty {
					ToolbarItem(placement: .topBarTrailing) {
						Button("Sign out") {
							Task { await session.signOut() }
						}
					}
				}
			}
			.overlay {
				if isSwitching {
					ProgressView().controlSize(.large)
				}
			}
		}
	}
}

private struct OrganizationRow: View {
	let membership: OrganizationMembership

	var body: some View {
		HStack(spacing: 12) {
			Image(systemName: "building.2.fill")
				.foregroundStyle(.tint)
				.frame(width: 28)

			VStack(alignment: .leading, spacing: 2) {
				Text(membership.organization.name)
					.font(.body)
					.foregroundStyle(.primary)
				Text(membership.role.replacingOccurrences(of: "org:", with: "").capitalized)
					.font(.caption)
					.foregroundStyle(.secondary)
			}

			Spacer()
			Image(systemName: "chevron.right")
				.font(.caption.weight(.semibold))
				.foregroundStyle(.tertiary)
		}
	}
}
