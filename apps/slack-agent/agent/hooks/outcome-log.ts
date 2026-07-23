import { defineHook, type HookContext } from "eve/hooks";

/**
 * Unconditional structured turn-outcome + tool-failure logging — the eve-native
 * port of chat-flue's `observe()` bridge in apps/chat-flue/src/app.ts. Railway's
 * logs are the sink (chat-flue's was Workers Observability). It stays on whether
 * or not the OTel export (agent/instrumentation.ts) is enabled: these lines are
 * the primary signal for the "agent did nothing" failure mode.
 */

function teamIdOf(ctx: HookContext): string {
  const team = ctx.session.auth.current?.attributes?.team_id;
  return typeof team === "string" && team.length > 0 ? team : "(none)";
}

export default defineHook({
  events: {
    "turn.completed"(_event, ctx) {
      console.log(
        `[slack-agent] turn_end errored=false session=${ctx.session.id} team=${teamIdOf(ctx)}`,
      );
    },
    "turn.failed"(event, ctx) {
      console.error(
        `[slack-agent] turn_end errored=true session=${ctx.session.id} team=${teamIdOf(ctx)} ` +
          `code=${event.data.code} message=${JSON.stringify(event.data.message)}`,
      );
    },
    "action.result"(event, ctx) {
      const { result, status, error } = event.data;
      const failed = status === "failed" || result.isError === true;
      if (!failed) return;
      const label =
        result.kind === "tool-result"
          ? `tool ${result.toolName}`
          : result.kind === "subagent-result"
            ? `subagent ${result.subagentName}`
            : "load_skill";
      console.error(
        `[slack-agent] ${label} failed session=${ctx.session.id} team=${teamIdOf(ctx)}`,
        error ?? "",
      );
    },
  },
});
