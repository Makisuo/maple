/**
 * The agent registry's invariants.
 *
 * These are all "a config mistake becomes a runtime mystery" cases: a mode with no agent, a
 * `spawns` entry naming nothing, or a sub-agent whose ruleset asks for an approval it has no way to
 * surface. Each is cheap to assert here and expensive to debug in a live turn.
 */
import { ChatMode, makeChatSessionId } from "@maple/domain/chat-session"
import { evaluatePermission } from "@maple/domain/permission"
import { assert, describe, it } from "vitest"
import { AGENTS, agentForSession, buildSystemPrompt, spawnableFor } from "./agents"
import { mapleToolCatalog } from "@/mcp/tools/registry"

const subagents = Object.values(AGENTS).filter((agent) => agent.mode === "subagent")

describe("AGENTS", () => {
	it("names an agent for every wire mode", () => {
		// `chatModeFromSessionId` is on the wire and the client derives from it, so a mode without a
		// matching agent is a runtime `undefined` in the middle of a turn.
		for (const mode of ChatMode.literals) {
			const agent = AGENTS[mode]
			assert.isDefined(agent, `no agent for mode ${mode}`)
			assert.equal(agent?.mode, "primary", `${mode} must name a primary agent`)
			assert.equal(agent?.name, mode)
		}
	})

	it("resolves every spawnable name to a real sub-agent", () => {
		for (const agent of Object.values(AGENTS)) {
			for (const name of agent.spawns ?? []) {
				assert.equal(AGENTS[name]?.mode, "subagent", `${agent.name} spawns unknown ${name}`)
			}
		}
	})

	it("gives no sub-agent a tool that would need approval", () => {
		// A nested turn cannot surface an approval card: approval ends the *outer* turn and is
		// applied out of band by `POST /api/chat/apply`. An `ask` here would deadlock the sub-agent
		// into proposing something nobody can accept.
		for (const agent of subagents) {
			for (const definition of mapleToolCatalog) {
				assert.notEqual(
					evaluatePermission(agent.permission, definition.name),
					"ask",
					`${agent.name} would ask for ${definition.name}`,
				)
			}
		}
	})

	it("denies `task` to every sub-agent, capping nesting structurally", () => {
		// The numeric depth cap in the task tool is the belt; this is the braces. A sub-agent whose
		// ruleset offered `task` could nest regardless of what the counter said.
		for (const agent of subagents) {
			assert.equal(evaluatePermission(agent.permission, "task"), "deny", agent.name)
		}
	})

	it("has at least one sub-agent, or the delegation machinery is dead code", () => {
		assert.isNotEmpty(subagents)
	})
})

describe("agentForSession", () => {
	it("maps a session id to its mode's agent", () => {
		assert.equal(agentForSession(makeChatSessionId("org_1", "tab")).name, "default")
		assert.equal(
			agentForSession(makeChatSessionId("org_1", "dashboard-builder-123")).name,
			"dashboard-builder",
		)
		assert.equal(agentForSession(makeChatSessionId("org_1", "inv-abc")).name, "investigate")
	})
})

describe("buildSystemPrompt", () => {
	it("appends delegation guidance naming exactly the agents this one can spawn", () => {
		const prompt = buildSystemPrompt(AGENTS.default!)

		assert.include(prompt, "explore")
		assert.include(prompt, "task")
		// Generated from the registry, so the prompt and the tool description cannot disagree about
		// what is delegable.
		for (const agent of subagents.filter((candidate) => candidate.name !== "explore")) {
			assert.notInclude(prompt, agent.description)
		}
	})

	it("says nothing about delegating when the agent cannot", () => {
		const prompt = buildSystemPrompt(AGENTS["dashboard-builder"]!)

		assert.isEmpty(spawnableFor(AGENTS["dashboard-builder"]!))
		assert.notInclude(prompt, "## Delegating")
	})

	it("gives a sub-agent its own persona, not the default one", () => {
		assert.notInclude(buildSystemPrompt(AGENTS.explore!), "## Delegating")
		assert.include(buildSystemPrompt(AGENTS.explore!), "read-only investigator")
	})
})
