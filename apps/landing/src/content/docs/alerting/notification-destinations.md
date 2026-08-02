---
title: "Notification destinations"
description: "Route Maple alerts to Slack, PagerDuty, Discord, or any HTTP endpoint. How to add a destination, send a test, and get the right credentials for each provider."
group: "Alerting"
order: 0
---

A **notification destination** is where Maple delivers an alert when one of your rules fires. Add destinations once, then attach them to any number of alert rules — when a rule trips, Maple sends a `trigger`; when it recovers, a `resolve`.

Destinations live under **Alerts → Settings** in the Maple dashboard. Open the destinations section, click **Add destination**, and pick a provider. Provider credentials are encrypted at rest and never returned to the browser after they're saved.

## Sending a test

Every destination has a **Send test** button. It delivers a sample alert through the real provider path — the same code that delivers production alerts — so it's the fastest way to confirm your credentials are valid before you wire the destination to a rule.

If a test fails, Maple surfaces the provider's own rejection reason in the toast (and on the destination card as the last test error). For example, a bad PagerDuty key reports `PagerDuty delivery failed with 400: Invalid routing key` — read that message; it tells you exactly what the provider rejected.

## Slack

Install Maple's Slack app, then choose the channel where alerts should be delivered. Maple uses the
installed bot connection; incoming-webhook destinations are not supported.

1. Open **Alerts → Settings** and choose **Add destination → Slack**.
2. Install or reconnect the Maple Slack app when prompted.
3. Pick a channel and save the destination.

## PagerDuty

Trigger PagerDuty incidents through the **Events API v2**. The single most common setup mistake is pasting the **wrong key** — PagerDuty has several, and only one works here.

> **Use an Events API v2 _integration key_ (also called a _routing key_) — a 32-character string.**
> A PagerDuty **REST API token** (from _User Settings_ or _API Access Keys_) will **not** work and produces `PagerDuty delivery failed with 400: Invalid routing key` on test send. The REST API is for managing PagerDuty itself; the Events API is what Maple posts alerts to, and it's scoped to a specific service.

To get the right key:

1. In PagerDuty, go to **Services → Service Directory** and open (or create) the service that should receive these alerts.
2. Open the **Integrations** tab.
3. Click **Add integration** and choose **Events API v2**.
4. Copy that integration's **Integration Key** (32 characters).
5. Paste it into Maple's **Integration key** field and click **Send test**.

See PagerDuty's own [services and integrations guide](https://support.pagerduty.com/main/docs/services-and-integrations) for screenshots.

| Field               | Notes                                                            |
| ------------------- | ---------------------------------------------------------------- |
| **Integration key** | The 32-character Events API v2 routing key from the steps above. |

When an alert fires, Maple sends an Events API v2 `trigger` with a stable `dedup_key`, and a matching `resolve` when the rule recovers — so PagerDuty groups the lifecycle into one incident.

## Discord

Post alerts to a Discord channel via an incoming webhook.

1. In Discord: **Channel settings → Integrations → Webhooks → New Webhook**.
2. Copy the webhook URL (`https://discord.com/api/webhooks/...`) into the **Discord webhook URL** field.

## Webhook

POST a signed JSON payload to any HTTP endpoint you control — useful for custom routing, on-call tools without a native integration, or your own automation.

- Maple sends a JSON body describing the rule, the observed value, and links back into the dashboard.
- Set an optional **signing secret** to receive an `x-maple-signature` HMAC-SHA256 header so your endpoint can verify the payload came from Maple.
- Your endpoint should respond with a `2xx` status; any other status is treated as a delivery failure and surfaced on the destination.

## Hazel

Connect [Hazel](https://hazel.sh/docs/integrations/maple) through OAuth and pick a workspace channel
to route alerts into. See Hazel's [Maple integration guide](https://hazel.sh/docs/integrations/maple).
