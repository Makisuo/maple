import Foundation
import MapleAPI

/// How an issue names itself.
///
/// Shared rather than private to `IssueRow`: the Home Screen widget shows the
/// same rows, and a title that falls back differently on the widget than in the
/// list reads as two different issues.
extension ErrorIssue {
	/// The exception type, or — for the kinds that carry none (integration and
	/// alert issues) — the label, or failing that the message.
	var displayTitle: String {
		let type = exceptionType.trimmingCharacters(in: .whitespacesAndNewlines)
		if !type.isEmpty { return type }
		let label = errorLabel.trimmingCharacters(in: .whitespacesAndNewlines)
		return label.isEmpty ? exceptionMessage : label
	}

	/// The message, suppressed when it would merely restate the title — which
	/// is what happens once the title has fallen back to the label.
	var displaySubtitle: String? {
		let message = exceptionMessage.trimmingCharacters(in: .whitespacesAndNewlines)
		let title = displayTitle
		guard !message.isEmpty, !message.hasPrefix(title), !title.hasPrefix(message) else { return nil }
		return message
	}
}
