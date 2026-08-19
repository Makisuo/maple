import ClerkKit
import SwiftUI

/// Chooses the organization whose data the app will show.
///
/// This is not optional chrome. The v2 API has no org header and rejects a
/// token with no active-organization claim, so the app is unusable until one is
/// selected.
///
/// It serves two roles: the gate shown when no organization is active, and the
/// sheet behind the toolbar switcher. Without the second, a user with more than
/// one organization would be stuck on whichever one Clerk happened to activate —
/// the gate is unreachable once an org exists.
struct OrganizationPickerView: View {
	/// `gate` is the full-screen, no-way-out variant; `switcher` is the sheet.
	enum Mode {
		case gate
		case switcher
	}

	var mode: Mode = .gate

	@Environment(SessionController.self) private var session
	@Environment(\.dismiss) private var dismiss
	@State private var isSwitching = false

	var body: some View {
		NavigationStack {
			ZStack {
				Token.background.ignoresSafeArea()

				if session.memberships.isEmpty {
					if session.membershipsLoaded {
						noMemberships
					} else {
						// Still fetching. Showing the "no organizations" dead end
						// here would be both wrong and alarming.
						SkeletonList(rowHeight: 56, rows: 3)
					}
				} else {
					picker
				}
			}
			.navigationTitle(mode == .gate ? "Organization" : "Switch organization")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar { toolbar }
		}
		.tint(Token.primary)
		.task {
			// The sheet can outlive a stale list; refetch on present.
			if mode == .switcher { await session.loadMemberships() }
		}
	}

	@ToolbarContentBuilder
	private var toolbar: some ToolbarContent {
		switch mode {
		case .gate:
			if !session.memberships.isEmpty {
				ToolbarItem(placement: .topBarTrailing) {
					Button { Task { await session.signOut() } } label: {
						Text("Sign out")
							.font(Typo.smallMedium)
							.foregroundStyle(Token.mutedForeground)
					}
				}
			}
		case .switcher:
			ToolbarItem(placement: .topBarTrailing) {
				Button { dismiss() } label: {
					Text("Done")
						.font(Typo.smallMedium)
						.foregroundStyle(Token.primary)
				}
			}
		}
	}

	private var picker: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 0) {
				if let error = session.organizationError {
					Text(error)
						.font(Typo.small)
						.foregroundStyle(Token.destructive)
						.padding(16)
				}

				ForEach(session.memberships, id: \.id) { membership in
					Button {
						isSwitching = true
						Task {
							await session.select(organizationId: membership.organization.id)
							isSwitching = false
							if mode == .switcher, session.organizationError == nil { dismiss() }
						}
					} label: {
						OrganizationRow(
							membership: membership,
							isActive: membership.organization.id == session.activeOrganizationId
						)
					}
					.buttonStyle(RowButtonStyle())
					.disabled(isSwitching)
					Hairline()
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
			Button { Task { await session.signOut() } } label: {
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
	var isActive = false

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

			if isActive {
				Image(systemName: "checkmark")
					.font(.system(size: 12, weight: .semibold))
					.foregroundStyle(Token.primary)
			} else {
				Image(systemName: "chevron.right")
					.font(.system(size: 11, weight: .semibold))
					.foregroundStyle(Token.mutedForeground.opacity(0.6))
			}
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 14)
		.contentShape(.rect)
	}
}

/// The leading-toolbar control that opens the switcher.
///
/// This used to sit in `.principal` — the centred title slot — on all three
/// tabs, which is what made the chrome read as not-quite-native: iOS puts the
/// screen's *name* in the middle, so an organization there is a title that
/// isn't one, and it cost the app its large titles as a side effect. As a
/// leading item it reads as what it is (the context everything on screen is
/// scoped to) and the title slot goes back to the system.
///
/// When the account has a single organization there is nothing to switch to,
/// so the control disappears rather than sitting there dead — the screen's own
/// large title already names the place.
struct OrganizationSwitcherButton: View {
	@Environment(SessionController.self) private var session
	@State private var isPresented = false

	var body: some View {
		if session.canSwitchOrganization {
			Button { isPresented = true } label: {
				HStack(spacing: 5) {
					if let id = session.activeOrganizationId {
						ServiceDot(serviceName: id, size: 7)
					}
					Text(session.activeOrganization?.name ?? "Organization")
						.font(Typo.smallMedium)
						.foregroundStyle(Token.foreground)
						.lineLimit(1)
						// A long organization name must not push the trailing
						// item off the bar; the sheet shows the full name.
						.truncationMode(.tail)
					Image(systemName: "chevron.down")
						.font(.system(size: 8, weight: .semibold))
						.foregroundStyle(Token.mutedForeground)
				}
				.frame(maxWidth: 160, alignment: .leading)
			}
			.accessibilityLabel("Switch organization")
			.sheet(isPresented: $isPresented) {
				OrganizationPickerView(mode: .switcher)
					.environment(session)
			}
		}
	}
}
