/**
 * Alert/anomaly severity → issue severity.
 *
 * Two scales exist because two audiences do. `AlertSeverity` is the two-value
 * scale a person picks when authoring a rule (`warning | critical`);
 * `IssueSeverity` is the four-value scale everything downstream of an incident
 * reasons about (`critical | high | medium | low`). They are not the same set and
 * never were.
 *
 * The bug this fixes was silent in exactly the way that costs the most: the
 * investigation snapshot decoded `context.severity` against the *four*-value
 * literal, so a `warning` alert failed the decode, landed as `null`, and every
 * downstream severity decision treated the incident as unclassified. No error was
 * raised, because a failed decode was being read as "absent".
 *
 * Mapping here rather than widening `AlertSeverity` with `"high"`: that literal
 * is on the wire in alert-rule payloads, is stored on user-authored rules, and is
 * rendered by `severityEmoji`/`formatSeverityLabel`. Adding a member to it means
 * a schema migration over user data to fix a translation that belongs at the
 * boundary.
 */
import type { AlertSeverity, IssueSeverity } from "@maple/domain/http"

/**
 * `warning` maps to `medium`, not `low`.
 *
 * A rule someone bothered to author and that then fired is, by construction, not
 * the least interesting thing in the system — `low` is for the noise floor.
 */
export const issueSeverityFromAlert = (severity: AlertSeverity): IssueSeverity =>
	severity === "critical" ? "critical" : "medium"
