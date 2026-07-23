import { defineMcpClientConnection } from "eve/connections";
import type { ConnectionAuthResolver } from "eve/connections";
import { mapleToolApproval } from "#lib/approval.js";
import { mapleApiBaseUrl, resolveWorkspace } from "#lib/maple.js";

/**
 * Maple observability MCP server (streamable HTTP), authenticated per Slack
 * workspace.
 *
 * Unlike the channel's arg-less `botToken`, the MCP `auth` resolver receives
 * the active session context, and the Slack auth context carries `team_id` in
 * `ctx.session.auth.current.attributes` (set by eve's buildSlackAuthContext and
 * persisted with the session). So this path resolves the correct org's Maple
 * API key reliably, including in durable reply steps.
 *
 * If the workspace isn't linked, the resolver throws a clear message; the model
 * is instructed (agent/instructions.md) to explain that this Slack workspace is
 * not connected to a Maple organization and to point the user at the Maple
 * dashboard → Integrations → Slack.
 *
 * tools filter: left unfiltered. The tool names exposed by the Maple MCP server
 * are resolved at runtime from the live server, not known at authoring time, so
 * an allow/block list would be a guess. The safety boundary is the `approval`
 * policy instead (agent/lib/approval.ts): mutating tools pause for a Slack
 * approve/deny prompt, and on approve the real MCP tool executes — matching
 * chat-flue's full-list-plus-gates posture.
 */

const NOT_LINKED_MESSAGE =
  "This Slack workspace is not connected to a Maple organization. " +
  "Install the integration from the Maple dashboard → Integrations → Slack.";

const resolveAuth: ConnectionAuthResolver = async (ctx) => {
  const team = ctx.session.auth.current?.attributes?.team_id;
  const teamId = typeof team === "string" && team.length > 0 ? team : undefined;
  if (!teamId) throw new Error(NOT_LINKED_MESSAGE);
  return {
    getToken: async () => {
      const ws = await resolveWorkspace(teamId);
      if (!ws) throw new Error(NOT_LINKED_MESSAGE);
      return { token: ws.mapleApiKey };
    },
  };
};

export default defineMcpClientConnection({
  url: `${mapleApiBaseUrl()}/mcp`,
  description:
    "Maple observability platform: query the connected organization's " +
    "OpenTelemetry services, traces, spans, errors, logs and metrics.",
  auth: resolveAuth,
  approval: mapleToolApproval,
});
