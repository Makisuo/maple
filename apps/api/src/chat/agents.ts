/**
 * The agents a chat turn can run as.
 *
 * Supersedes `modes.ts`, which was a string switch from `ChatMode` to a system prompt. An agent is
 * now a record: a prompt, a permission ruleset, an optional step budget, and the sub-agents it may
 * delegate to. That is what makes "this surface should not be able to create alert rules" a
 * one-line change instead of a new branch in the loop.
 *
 * `ChatMode` and `chatModeFromSessionId` are deliberately untouched — they are on the wire and the
 * web client derives from them. Every mode names a primary agent, by construction; `agents.test.ts`
 * fails if one is ever added without one.
 */
import { chatModeFromSessionId, type ChatMode } from "@maple/domain/chat-session"
import type { PermissionRuleset } from "@maple/domain/permission"
import { DEFAULT_RULESET, READ_ONLY_RULESET } from "./permissions"
import {
	DASHBOARD_BUILDER_SYSTEM_PROMPT,
	EXPLORE_SYSTEM_PROMPT,
	INVESTIGATE_SYSTEM_PROMPT,
	SYSTEM_PROMPT,
} from "./prompts"

export interface AgentDefinition {
	readonly name: string
	/** Shown to a *calling* model in the `task` tool's description. Written for that reader. */
	readonly description: string
	/** `primary` — a session runs as this. `subagent` — only reachable through the `task` tool. */
	readonly mode: "primary" | "subagent"
	readonly prompt: string
	readonly permission: PermissionRuleset
	/** Overrides the turn's default step cap. */
	readonly steps?: number
	/**
	 * Sub-agents this agent may spawn. Empty (the default) means it gets no `task` tool at all —
	 * the capability is opt-in per agent, not something every turn carries.
	 */
	readonly spawns?: ReadonlyArray<string>
}

/**
 * Assistant turns a sub-agent gets.
 *
 * Two-thirds of the parent's budget: enough to search and summarize, not enough to wander. A
 * sub-agent that runs out simply reports what it found, which is a fine answer.
 */
export const SUBAGENT_MAX_STEPS = 6

export const AGENTS: Readonly<Record<string, AgentDefinition>> = {
	default: {
		name: "default",
		description: "General Maple assistant.",
		mode: "primary",
		prompt: SYSTEM_PROMPT,
		permission: DEFAULT_RULESET,
		spawns: ["explore"],
	},
	"dashboard-builder": {
		name: "dashboard-builder",
		description: "Builds and edits dashboards.",
		mode: "primary",
		prompt: DASHBOARD_BUILDER_SYSTEM_PROMPT,
		permission: DEFAULT_RULESET,
	},
	alert: {
		name: "alert",
		description: "Assists with an alert in context.",
		mode: "primary",
		prompt: SYSTEM_PROMPT,
		permission: DEFAULT_RULESET,
	},
	"widget-fix": {
		name: "widget-fix",
		description: "Repairs a dashboard widget in context.",
		mode: "primary",
		prompt: SYSTEM_PROMPT,
		permission: DEFAULT_RULESET,
	},
	investigate: {
		name: "investigate",
		description: "Runs an autonomous investigation.",
		mode: "primary",
		prompt: INVESTIGATE_SYSTEM_PROMPT,
		permission: DEFAULT_RULESET,
		spawns: ["explore"],
	},
	explore: {
		name: "explore",
		description:
			"Read-only investigator. Give it a self-contained question about traces, logs, metrics " +
			"or errors and it returns a written answer. It cannot change anything and cannot spawn " +
			"further agents. Use it to search broadly without filling this conversation with raw " +
			"tool output.",
		mode: "subagent",
		prompt: EXPLORE_SYSTEM_PROMPT,
		permission: READ_ONLY_RULESET,
		steps: SUBAGENT_MAX_STEPS,
	},
} as const

/** Every `ChatMode` literal names a primary agent; the mode string *is* the agent name. */
export const agentForSession = (sessionId: string): AgentDefinition => {
	const mode: ChatMode = chatModeFromSessionId(sessionId)
	// Non-null by construction, and pinned by `agents.test.ts` rather than by hope.
	return AGENTS[mode]!
}

/** The sub-agents `agent` is allowed to spawn, resolved and filtered to real subagent records. */
export const spawnableFor = (agent: AgentDefinition): ReadonlyArray<AgentDefinition> =>
	(agent.spawns ?? [])
		.map((name) => AGENTS[name])
		.filter((candidate): candidate is AgentDefinition => candidate?.mode === "subagent")

/**
 * The delegation paragraph appended to a system prompt when an agent can spawn.
 *
 * The prompt-side twin of the `task` tool's generated description: the tool tells the model *how*
 * to call, this tells it *when*. Both are generated from the registry so there is one source of
 * truth for what a given agent can delegate to.
 */
const taskGuidance = (spawnable: ReadonlyArray<AgentDefinition>): string =>
	[
		"## Delegating",
		"",
		"You can hand a self-contained research question to a sub-agent with the `task` tool. The " +
			"sub-agent runs its own tool loop and returns a written answer — its raw tool output never " +
			"enters this conversation, so delegation is how you search broadly without burying the " +
			"thread in payloads. It sees NOTHING of this conversation, so its prompt must stand alone.",
		"",
		"Available sub-agents:",
		...spawnable.map((agent) => `- \`${agent.name}\`: ${agent.description}`),
	].join("\n")

/** The system prompt for a turn: the agent's own persona, plus delegation guidance if it can. */
export const buildSystemPrompt = (agent: AgentDefinition): string => {
	const spawnable = spawnableFor(agent)
	return spawnable.length === 0 ? agent.prompt : `${agent.prompt}\n\n${taskGuidance(spawnable)}`
}
