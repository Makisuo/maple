import { slackChannel } from "eve/channels/slack";
import type { SlackWebhookVerifier } from "eve/channels/slack";
import {
  enterTeam,
  parseSlackTeamId,
  recordTeam,
  resolveBotToken,
  verifySlackV0Signature,
} from "#lib/maple.js";

/**
 * Multi-workspace, self-managed Slack app — no Vercel Connect.
 *
 * The Slack signing secret is per-app/static (`SLACK_SIGNING_SECRET`); only the
 * *bot token* varies per workspace. So we:
 *   1. Verify every inbound webhook's v0 signature with the static secret in a
 *      custom `webhookVerifier`, and record the request's `team_id` for the
 *      arg-less `botToken` resolver (see agent/lib/maple.ts for how that bridge
 *      works and its concurrency caveat).
 *   2. Resolve the outbound bot token per team via Maple's resolve endpoint,
 *      falling back to `SLACK_BOT_TOKEN` for single-workspace dev.
 *
 * Slack delivers events to POST /eve/v1/slack.
 */

const webhookVerifier: SlackWebhookVerifier = async (request, body) => {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    // No secret → cannot verify anything. Reject (returning falsy rejects).
    // Slack disables event subscriptions after repeated delivery failures, so
    // make the two rejection causes distinguishable in Railway logs. Never log
    // the secret or signature values themselves.
    console.warn(
      "[slack-webhook] Rejected inbound Slack webhook: SLACK_SIGNING_SECRET is not set, so no request can be verified.",
    );
    return false;
  }
  if (!verifySlackV0Signature(body, request.headers, signingSecret)) {
    console.warn(
      "[slack-webhook] Rejected inbound Slack webhook: v0 signature verification failed (missing headers, stale timestamp, or signature mismatch — check that SLACK_SIGNING_SECRET matches the Slack app).",
    );
    return false;
  }

  // Signature is good. Record the team so the arg-less botToken can resolve it.
  // (`url_verification` challenges carry no team_id and need no token — the
  // channel answers the challenge before any outbound call.)
  const teamId = parseSlackTeamId(body);
  if (teamId) {
    recordTeam(teamId);
    enterTeam(teamId);
  }

  // Return the verified body so eve uses it downstream.
  return body;
};

export default slackChannel({
  credentials: {
    webhookVerifier,
    // Per-team bot token. Arg-less by eve's contract; resolves the current
    // team's token (or SLACK_BOT_TOKEN in single-workspace dev mode).
    botToken: async () => resolveBotToken(),
  },
  // Repeated mentions in a thread only inject what's new since the agent's
  // last reply, instead of re-reading the whole thread each time.
  threadContext: { since: "last-agent-reply" },
});
