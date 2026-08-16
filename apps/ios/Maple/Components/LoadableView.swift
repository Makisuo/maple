import MapleAPI
import SwiftUI

/// The four states every screen in this app can be in.
///
/// `empty` is separated from `loaded([])` on purpose: "no services reported in
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
	/// instead of flashing a spinner.
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
	let retry: () -> Void
	@ViewBuilder let content: (Value) -> Content

	var body: some View {
		switch state {
		case .loading:
			ProgressView()
				.controlSize(.large)
				.frame(maxWidth: .infinity, maxHeight: .infinity)

		case .empty:
			ContentUnavailableView {
				Label(emptyTitle, systemImage: "tray")
			} description: {
				Text(emptyMessage)
			}

		case .failed(let error):
			ErrorStateView(error: error, retry: retry)

		case .loaded(let value):
			content(value)
		}
	}
}

struct ErrorStateView: View {
	let error: MapleAPIError
	let retry: () -> Void

	var body: some View {
		ContentUnavailableView {
			Label(error.title, systemImage: icon)
		} description: {
			Text(error.message)
		} actions: {
			// Offering "Try again" on a validation error would be a lie — the
			// same request fails the same way.
			if error.isRetryable {
				Button("Try again", action: retry)
					.buttonStyle(.borderedProminent)
			}
		}
	}

	private var icon: String {
		switch error {
		case .transport: "wifi.exclamationmark"
		case .notAuthenticated: "person.crop.circle.badge.exclamationmark"
		default: "exclamationmark.triangle"
		}
	}
}
