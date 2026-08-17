import type { IsoDateTimeString } from "@maple/primitives"
import { DashboardDocumentV3 } from "./v3/document"

/**
 * Carry a stored dashboard forward with a new widget array.
 *
 * Spreads the decoded document rather than naming its fields, and that is the
 * whole point. The MCP mutation path used to rebuild the document from an
 * explicit field list, which silently dropped `sections`, `variables`,
 * `refreshIntervalSeconds` and `schemaVersion` on *every* widget add, update,
 * remove, reorder and replace — and `sanitizeDashboardSections` then stripped the
 * newly-orphaned `sectionId`/`tabId` off each widget on write, so the loss was
 * unrecoverable. Anything added to `makeDashboardDocumentFields` now survives a
 * widget mutation for free.
 *
 * A spread is safe because a decoded `Schema.Class` instance carries only the
 * keys it actually has: an absent `Schema.optionalKey` field is not an own
 * property, so nothing forwards a present `undefined` (which the constructor
 * rejects). Building the props by hand is what made that dance look necessary.
 */
export const withWidgets = (
	document: DashboardDocumentV3,
	widgets: DashboardDocumentV3["widgets"],
	updatedAt: IsoDateTimeString,
): DashboardDocumentV3 => new DashboardDocumentV3({ ...document, widgets, updatedAt })
