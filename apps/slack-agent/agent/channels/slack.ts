import { slackChannel } from "eve/channels/slack";

/**
 * Self-managed Slack app — no Vercel Connect.
 *
 * Credentials fall back to env vars (see .env.local.example):
 *   - botToken       -> SLACK_BOT_TOKEN     (outbound Web API calls)
 *   - signingSecret  -> SLACK_SIGNING_SECRET (HMAC-verifies inbound webhooks)
 *
 * Slack delivers events to POST /eve/v1/slack. Point your Slack app's
 * Event Subscriptions "Request URL" at https://<host>/eve/v1/slack.
 */
export default slackChannel({
  // Repeated mentions in a thread only inject what's new since the agent's
  // last reply, instead of re-reading the whole thread each time.
  threadContext: { since: "last-agent-reply" },
});
