import MapleAPI
import SwiftUI
import UIKit

/// What this phone gets pushed, for the current organization.
///
/// Toggles write locally first (the sheet stays snappy), and the tab root's
/// sync task sees the changed key and re-registers. Permission lives at the
/// top because everything below it is moot without it.
struct NotificationSettingsView: View {
	@Environment(SessionController.self) private var session
	@Environment(\.dismiss) private var dismiss
	private let push = PushRegistrar.shared
	private let liveActivities = LiveActivityController.shared

	@State private var preferences = PushPreferences.default

	private var orgId: String? { session.currentOrganizationId }

	var body: some View {
		NavigationStack {
			ZStack {
				Token.background.ignoresSafeArea()
				ScrollView {
					VStack(alignment: .leading, spacing: 24) {
						permissionSection
						if push.authorization == .authorized {
							prefsSection("Alerts") {
								toggle("Critical incidents", "Breaks through Focus.", \.criticalIncidents)
								toggle("Warnings", nil, \.warningIncidents)
								toggle("Resolved", "Quiet — no sound, no Focus.", \.resolvedIncidents)
							}
							liveActivitySection
							prefsSection("Errors and anomalies") {
								toggle("New error issues", "Not yet delivered; coming with issue notifications.", \.newErrorIssues)
								toggle("Anomalies", "Not yet delivered; coming with anomaly notifications.", \.anomalies)
							}
							statusFooter
						}
					}
					.padding(.vertical, 16)
				}
				.scrollContentBackground(.hidden)
			}
			.navigationTitle("Notifications")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .principal) {
					Text("Notifications").font(Typo.monoTitle).foregroundStyle(Token.foreground)
				}
				ToolbarItem(placement: .topBarTrailing) {
					Button("Done") { dismiss() }
						.font(Typo.smallMedium)
						.foregroundStyle(Token.foreground)
				}
			}
			.mapleScreen(Screen.notificationSettings)
			.task {
				await push.refreshAuthorization()
				liveActivities.refreshAuthorization()
				if let orgId { preferences = push.preferences(for: orgId) }
			}
		}
		.presentationDetents([.large])
	}

	// MARK: Permission

	@ViewBuilder
	private var permissionSection: some View {
		VStack(alignment: .leading, spacing: 10) {
			SectionLabel("Permission").padding(.horizontal, 16)
			VStack(alignment: .leading, spacing: 12) {
				switch push.authorization {
				case .authorized:
					statusRow(dot: Token.success, title: "Notifications on", detail: tokenDetail)
				case .denied:
					statusRow(
						dot: Token.destructive,
						title: "Notifications off",
						detail: "Turned off in iOS Settings. Maple can't ask again from here."
					)
					actionButton("Open Settings") {
						if let url = URL(string: UIApplication.openSettingsURLString) {
							UIApplication.shared.open(url)
						}
					}
				case .notDetermined, .unknown:
					statusRow(
						dot: Token.mutedForeground,
						title: "Not asked yet",
						detail: "Get a push when an alert opens or resolves in \(orgName)."
					)
					actionButton("Turn on notifications") {
						Task { await push.requestAuthorization() }
					}
				}
			}
			.padding(16)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(Token.card, in: .rect(cornerRadius: Token.Radius.lg))
			.overlay(RoundedRectangle(cornerRadius: Token.Radius.lg).stroke(Token.border, lineWidth: Token.hairline))
			.padding(.horizontal, 16)
		}
	}

	private var tokenDetail: String {
		if push.deviceToken == nil {
			#if targetEnvironment(simulator)
				return "The simulator has no push token — run on a device to receive anything."
			#else
				return "Waiting for a device token from iOS…"
			#endif
		}
		if let error = push.lastError { return "Registration failed: \(error)" }
		return "This phone is registered with \(orgName)."
	}

	private var orgName: String {
		session.activeOrganization?.name ?? "this organization"
	}

	private func statusRow(dot: Color, title: String, detail: String) -> some View {
		HStack(alignment: .top, spacing: 10) {
			Circle().fill(dot).frame(width: 7, height: 7).offset(y: 5)
			VStack(alignment: .leading, spacing: 4) {
				Text(title).font(Typo.bodyMedium).foregroundStyle(Token.foreground)
				Text(detail)
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
					.fixedSize(horizontal: false, vertical: true)
			}
		}
	}

	private func actionButton(_ title: String, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			Text(title)
				.font(Typo.smallMedium)
				.foregroundStyle(Token.primaryForeground)
				.padding(.horizontal, 14)
				.frame(height: 32)
				.background(Token.primary, in: .rect(cornerRadius: Token.Radius.md))
		}
		.buttonStyle(.plain)
	}

	// MARK: Live Activities

	/// Not a toggle: iOS owns this switch, and Maple can only report what it
	/// finds. Shown even when it is on, so "why is there nothing on my Lock
	/// Screen" has an answer in the app rather than three levels into Settings.
	@ViewBuilder
	private var liveActivitySection: some View {
		VStack(alignment: .leading, spacing: 10) {
			SectionLabel("Lock Screen").padding(.horizontal, 16)
			VStack(alignment: .leading, spacing: 12) {
				if liveActivities.areActivitiesEnabled {
					statusRow(
						dot: Token.success,
						title: "Live Activities on",
						detail: liveActivities.pushToStartToken == nil
							? "A critical incident will appear on your Lock Screen once iOS issues this phone a token."
							: "A critical incident shows on your Lock Screen until it resolves."
					)
					if FixtureAPI.isEnabled {
						// Fixture mode has no incidents and no pushes; this is how the
						// card gets designed and screenshotted.
						actionButton("Preview on Lock Screen") {
							liveActivities.startPreviewActivity()
						}
					}
				} else {
					statusRow(
						dot: Token.mutedForeground,
						title: "Live Activities off",
						detail: "Turn on Live Activities for Maple in iOS Settings to see critical incidents on the Lock Screen."
					)
					actionButton("Open Settings") {
						if let url = URL(string: UIApplication.openSettingsURLString) {
							UIApplication.shared.open(url)
						}
					}
				}
			}
			.padding(16)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(Token.card, in: .rect(cornerRadius: Token.Radius.lg))
			.overlay(RoundedRectangle(cornerRadius: Token.Radius.lg).stroke(Token.border, lineWidth: Token.hairline))
			.padding(.horizontal, 16)
		}
	}

	// MARK: Preferences

	@ViewBuilder
	private func prefsSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
		VStack(alignment: .leading, spacing: 10) {
			SectionLabel(title).padding(.horizontal, 16)
			VStack(spacing: 0) { content() }
				.background(Token.card, in: .rect(cornerRadius: Token.Radius.lg))
				.overlay(RoundedRectangle(cornerRadius: Token.Radius.lg).stroke(Token.border, lineWidth: Token.hairline))
				.padding(.horizontal, 16)
		}
	}

	private func toggle(_ title: String, _ detail: String?, _ keyPath: WritableKeyPath<PushPreferences, Bool>) -> some View {
		VStack(spacing: 0) {
			Toggle(isOn: binding(keyPath)) {
				VStack(alignment: .leading, spacing: 3) {
					Text(title).font(Typo.body).foregroundStyle(Token.foreground)
					if let detail {
						Text(detail).font(Typo.tiny).foregroundStyle(Token.mutedForeground)
					}
				}
			}
			// Green for "on", not the amber primary — that appears once per
			// screen and it is spent on the permission button.
			.tint(Token.success)
			.padding(.horizontal, 16)
			.frame(minHeight: 52)
			Hairline().padding(.leading, 16)
		}
	}

	private func binding(_ keyPath: WritableKeyPath<PushPreferences, Bool>) -> Binding<Bool> {
		Binding(
			get: { preferences[keyPath: keyPath] },
			set: { value in
				preferences[keyPath: keyPath] = value
				if let orgId { push.setPreferences(preferences, for: orgId) }
			}
		)
	}

	private var statusFooter: some View {
		Text(
			push.isSyncing
				? "Saving…"
				: "Preferences apply to \(orgName) on this phone. Switch organizations to set theirs."
		)
		.font(Typo.tiny)
		.foregroundStyle(Token.mutedForeground.opacity(0.7))
		.padding(.horizontal, 16)
	}
}
