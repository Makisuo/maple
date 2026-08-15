/**
 * The rulesets Maple's chat agents run under.
 *
 * `MUTATING_TOOL_NAMES` stays exactly where it is and keeps its shape: it seeds `DEFAULT_RULESET`
 * here, and it remains the allowlist floor for `POST /internal/chat/apply`. That is the whole migration
 * story — the mirror in `apps/slack-agent/agent/lib/approval.ts` needs no change, and the
 * equivalence is pinned by a test in `apps/api/src/mcp/tools/mutating.test.ts` so day-one behaviour
 * cannot drift by accident.
 */
import { PermissionRule, type PermissionRuleset } from "@maple/domain/permission"
import { MUTATING_TOOL_NAMES } from "@/mcp/tools/mutating"
import { mapleToolCatalog } from "@/mcp/tools/registry"

/**
 * Today's behaviour, expressed as data: everything runs, mutations stop and ask.
 *
 * Sorted so the ruleset is stable across builds — it is a value that will end up in logs and,
 * eventually, in a settings UI diff.
 */
export const DEFAULT_RULESET: PermissionRuleset = [
	new PermissionRule({ tool: "*", action: "allow" }),
	...[...MUTATING_TOOL_NAMES].sort().map((tool) => new PermissionRule({ tool, action: "ask" })),
]

/**
 * Read-only: deny everything, then name the tools that are allowed.
 *
 * Deliberately an allowlist of *concrete registered names* rather than `deny "*"` plus `allow
 * "get_*"` globs. A mutating tool added next month is denied by default under this ruleset instead
 * of slipping through whatever glob happened to match its name.
 *
 * Note what this also denies by omission: `task`. A sub-agent running under this ruleset physically
 * cannot spawn another one, because `buildChatTools` never offers it the tool.
 */
export const READ_ONLY_RULESET: PermissionRuleset = [
	new PermissionRule({ tool: "*", action: "deny" }),
	...mapleToolCatalog
		.filter((definition) => !MUTATING_TOOL_NAMES.has(definition.name))
		.map((definition) => definition.name)
		.sort()
		.map((tool) => new PermissionRule({ tool, action: "allow" })),
]
