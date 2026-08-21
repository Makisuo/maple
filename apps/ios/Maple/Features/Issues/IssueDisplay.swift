import Foundation
import MapleAPI
import MapleWidgetData

/// How an issue names itself.
///
/// The fallback itself lives in `MapleWidgetData` as `WidgetIssueTitle`, not
/// here: the Home Screen widget shows the same rows from a different wire shape
/// (`WidgetSummaryPayload.Issue`, which carries the raw fields rather than a
/// rendered title), and a title that falls back differently on the widget than
/// in the list reads as two different issues. This is the `ErrorIssue`-shaped
/// door onto that one implementation.
extension ErrorIssue {
	/// The exception type, or — for the kinds that carry none (integration and
	/// alert issues) — the label, or failing that the message.
	var displayTitle: String {
		WidgetIssueTitle.title(
			exceptionType: exceptionType,
			errorLabel: errorLabel,
			exceptionMessage: exceptionMessage
		)
	}

	/// The message, suppressed when it would merely restate the title — which
	/// is what happens once the title has fallen back to the label.
	var displaySubtitle: String? {
		WidgetIssueTitle.subtitle(
			exceptionType: exceptionType,
			errorLabel: errorLabel,
			exceptionMessage: exceptionMessage
		)
	}
}
