import { slackChannel } from "eve/channels/slack";
import type { SlackWebhookVerifier } from "eve/channels/slack";
import {
  resolveBotToken,
  verifySlackV0Signature,
  type SlackTokenContext,
} from "#lib/maple.js";

/**
 * Multi-workspace, self-managed Slack app — no Vercel Connect.
 *
 * The Slack signing secret is per-app/static (`SLACK_SIGNING_SECRET`); only the
 * *bot token* varies per workspace. So we:
 *   1. Verify every inbound webhook's v0 signature with the static secret in a
 *      custom `webhookVerifier`.
 *   2. Resolve the outbound bot token per team via Maple's resolve endpoint.
 *      Our patched eve (patches/eve@0.25.3.patch, tracking vercel/eve#222)
 *      passes `{ teamId, channelId, threadTs }` into the credential;
 *      `SLACK_BOT_TOKEN` is the fallback for single-workspace dev and
 *      context-less paths.
 *
 * Slack delivers events to POST /eve/v1/slack.
 */

const webhookVerifier: SlackWebhookVerifier = async (request, body) => {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
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

  // Return the verified body so eve uses it downstream.
  return body;
};

export default slackChannel({
  credentials: {
    webhookVerifier,
    // Per-team bot token. Our patched eve passes the outbound call's
    // { teamId, channelId, threadTs }; context-less paths fall back to
    // SLACK_BOT_TOKEN.
    botToken: async (context?: SlackTokenContext) => resolveBotToken(context),
  },
  // Repeated mentions in a thread only inject what's new since the agent's
  // last reply, instead of re-reading the whole thread each time.
  threadContext: { since: "last-agent-reply" }
});
