/**
 * What an agent is allowed to do with a tool.
 *
 * Replaces a flat `Set` of mutating tool names. The set answered exactly one question — "does this
 * need approval?" — and could not express the two other things Maple wants: a tool an agent should
 * never even *see* (a read-only sub-agent), and a tool an agent may run without asking.
 *
 * Lives in `@maple/domain` rather than `apps/api` because the obvious next step is per-org rulesets
 * stored in Postgres and edited in settings, which the web client has to decode. It has no
 * `apps/api` dependency; the *agent registry* — prompts, model choices — stays server-side.
 *
 * ## One match dimension, not two
 *
 * opencode's equivalent matches on a `{permission, pattern}` pair because `bash` is a single
 * permission with infinitely many command patterns behind it. Every Maple tool is a distinct name
 * with a typed schema, so the second dimension would be dead weight. If argument-level gating ever
 * becomes necessary (`run_sql` with DDL, say), it arrives as an optional third field and the
 * evaluation below does not change.
 */
import { Schema } from "effect"
import { matchesGlob } from "./glob"

/**
 * - `allow` — the tool executes inside the turn.
 * - `ask` — the turn *stops*: the call is emitted as a proposal and applied out of band by
 *   `POST /internal/chat/apply`. Maple has no in-turn suspend; see the note on `ask` below.
 * - `deny` — the tool is omitted from the request entirely. The model never learns it exists,
 *   which is a stronger and cheaper guarantee than refusing the call after the fact.
 */
export const PermissionAction = Schema.Literals(["allow", "ask", "deny"])
export type PermissionAction = Schema.Schema.Type<typeof PermissionAction>

export class PermissionRule extends Schema.Class<PermissionRule>("@maple/PermissionRule")({
	/** Glob over the MCP tool's base name: `"*"`, `"create_*"`, `"update_dashboard"`. */
	tool: Schema.String,
	action: PermissionAction,
}) {}

/** Ordered, and the order is the semantics: **the last matching rule wins**. */
export const PermissionRuleset = Schema.Array(PermissionRule)
export type PermissionRuleset = Schema.Schema.Type<typeof PermissionRuleset>

/**
 * What an unmatched tool gets.
 *
 * Fails closed. A ruleset that forgot to mention a newly-added mutating tool should stop and ask,
 * not run it.
 */
export const DEFAULT_PERMISSION_ACTION: PermissionAction = "ask"

/**
 * Resolve one tool against a ruleset.
 *
 * Last-match-wins rather than first-match-wins so a ruleset reads as a base plus exceptions —
 * `[{"*": allow}, {"create_*": deny}]` says what it looks like it says.
 */
export const evaluatePermission = (ruleset: PermissionRuleset, tool: string): PermissionAction => {
	let action: PermissionAction = DEFAULT_PERMISSION_ACTION
	for (const rule of ruleset) {
		if (matchesGlob(rule.tool, tool)) action = rule.action
	}
	return action
}

/** Convenience for the two places that only care whether the model should see a tool at all. */
export const isToolVisible = (ruleset: PermissionRuleset, tool: string): boolean =>
	evaluatePermission(ruleset, tool) !== "deny"
