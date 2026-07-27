import { disableTool } from "eve/tools"

/**
 * eve ships `bash` on by default (see eve's REGISTERED_FRAMEWORK_TOOLS), and
 * nothing in this agent needs a shell. Everything it knows comes from the
 * Maple MCP connection.
 *
 * That default matters here because the agent reads attacker-influenced text:
 * log bodies, exception messages and span attributes flow from a customer's
 * production traffic straight into the model's context. Any tool left enabled
 * is a tool one crafted log line can ask the model to call, and our approval
 * gate (#lib/approval.js) only covers `maple__*` names — a framework tool runs
 * with no prompt at all.
 *
 * The filename IS the identity: eve derives the tool slug from the path
 * (`compileToolEntry` in eve's compiler) and refuses to boot if it matches no
 * framework tool, so a typo fails loudly rather than silently disabling
 * nothing. agent/lib/framework-tools.test.ts asserts the resolved set.
 */
export default disableTool()
