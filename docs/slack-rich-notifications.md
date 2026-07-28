# Rich Slack Notifications for the Maple Slack Agent — Research Notes

Resources, approaches, and ideas for making Maple's Slack messages (alerts, digests, agent replies) beautiful and useful. Not an implementation spec.

## 1. The building blocks

### Block Kit (the foundation)

Everything visual in a Slack message is composed from **blocks**: `header`, `section` (text + optional right-side accessory image/button), `context` (small grey metadata line), `divider`, `actions` (buttons/menus), `image`, `rich_text`, `markdown`. Renders consistently on desktop, mobile, and in push notifications.

- Reference: [Block Kit docs](https://docs.slack.dev/block-kit/) · [Creating rich message layouts](https://api.slack.com/messaging/composing/layouts)
- Prototype visually in the [Block Kit Builder](https://app.slack.com/block-kit-builder) — paste JSON, see it live, share permalinks.

### New in 2026: real markdown in Block Kit

As of the [March 2026 Block Kit rich-text update](https://docs.slack.dev/changelog/2026/03/06/block-kit-rich-text/), the `rich_text` and `markdown` blocks support:

- **Syntax-highlighted code blocks** (language-specific) — huge for showing stack traces / SQL / span attributes
- **Tables** — great for "top 5 slow endpoints" style summaries without ASCII art
- Task lists, dividers, variable-sized headers

This is worth leaning on: for an LLM agent, emitting a `markdown` block is far easier than assembling section-block JSON, and it now renders tables and highlighted code natively.

### Attachments (one legacy trick still worth keeping)

Attachments are deprecated in favor of blocks, **except** for the colored left border bar (`color: "#ff0000"`), which blocks can't do. The standard alert pattern is: blocks inside an attachment purely to get the severity color stripe (red = firing, green = resolved, yellow = warning). See [migrating attachments to blocks](https://api.slack.com/messaging/attachments-to-blocks).

## 2. Anatomy of a good alert message

Consensus pattern from Knock's guides and observability vendors (Datadog, Grafana, incident.io):

```
🔴 header      — "High error rate on checkout-api"  (subject line; emoji encodes severity)
section        — what happened, in one or two sentences; mrkdwn bold for key numbers
section fields — 2-column facts: Service, Env, Threshold, Current value
image          — chart of the offending metric (see §3)
context        — "Triggered 14:32 UTC · rule: error-rate-5m · org: acme"
actions        — [View in Maple] [Acknowledge] [Silence 1h]
```

Key principles:

- **Header = email subject line.** Concise, contextual, emoji-prefixed for scannability ([Knock's notification design guide](https://knock.app/blog/the-guide-to-designing-slack-notifications)).
- **Always set top-level `text`** as the push-notification fallback — that's what shows on a phone's lock screen.
- **Emoji do the work of color.** Slack gives you almost no styling palette; 🔴🟡🟢, ⚠️, 📈 encode state. Also usable in button labels to distinguish multiple default-styled buttons.
- **Button colors are sacred:** green (`primary`) / red (`danger`) only for clear confirm/destructive actions, everything else default.
- **Deep link everything.** Service name → service page, trace ID → trace view, each fact clickable. `<https://…|label>` mrkdwn links keep it compact.
- More depth: [Knock's Block Kit deep dive](https://knock.app/blog/taking-a-deep-dive-into-slack-block-kit) · [Slack integration patterns for alerts](https://dev.to/rosgluk/slack-integration-patterns-for-alerts-and-workflows-1ij5)

## 3. Charts in messages (the "rich" differentiator)

Slack can't render charts — only images. Options, in rough order of effort:

1. **URL-based chart service** — [QuickChart](https://quickchart.io/) (open source, self-hostable) takes a Chart.js config in the URL and returns a PNG; drop it in an `image` block. Has a dedicated [sparkline API](https://quickchart.io/documentation/sparkline-api/) and a [Slack-bot guide](https://quickchart.io/documentation/send-charts-with-slack-bot/). Fastest path; self-host to avoid leaking metric data to a third party.
2. **Render server-side, upload via `files.uploadV2`** — full control, matches Maple's chart aesthetic. Rendering options in a Workers/Bun environment: `@resvg/resvg-js` or Satori (SVG→PNG), or a headless-browser render of an existing Maple chart component. Uploaded files can be referenced in blocks via `slack_file`.
3. **Unicode sparklines** — `▁▂▄█▆▃` in a context block. Zero infra, surprisingly effective for a 12-bucket trend next to a number. Good fallback when image gen is unavailable.

Grafana's Slack alert screenshots are the reference UX here ([Grafana image-in-alert thread](https://community.grafana.com/t/slack-alerts-with-images/4097)): a small metric snapshot in the alert dramatically cuts "open the dashboard just to see if it's real" round-trips.

## 4. Lifecycle patterns (beyond a single message)

These matter as much as visual polish for alert UX:

- **Update-in-place with `chat.update`** — when the alert resolves, edit the original message (🔴→🟢, strike the actions). One source of truth per incident instead of a firing/resolved message pair.
- **Thread the lifecycle** — original message = incident header; state changes, agent analysis ("I looked at the traces, the spike correlates with deploy `534bf63`"), and human discussion go in the thread. Keeps channels scannable ([alert-channel patterns](https://www.glukhov.org/app-architecture/integration-patterns/slack/)).
- **Interactive actions** — Ack / Silence / Escalate buttons post back to the agent (Block Kit interactivity payloads). An ack should `chat.update` the message to show who acked (avatar + name in a context block).
- **Digests over floods** — batch low-severity findings into a periodic summary message (now easy with markdown tables). Per-channel/per-rule notification preferences beat firing everything ([Slack's app best practices](https://slack.dev/marketplace-best-practices/)).
- **Link unfurling** — register Maple domains with the Events API (`link_shared`) so any pasted `maple.dev/traces/…` link unfurls into a rich preview card. Huge perceived-quality win, works even when a human pastes a link.
- **App Home tab** — a persistent per-user dashboard surface (active alerts, watched services) built from the same blocks.

## 5. Authoring ergonomics (how to build the JSON)

- [`slack-block-builder`](https://www.npmjs.com/package/slack-block-builder) — chainable, SwiftUI-style, zero-dep, excellent TypeScript; has helpers like Paginator/Accordion and conditional appenders. Probably the best fit for `apps/slack-agent`.
- [`jsx-slack`](https://github.com/yhatt/jsx-slack) — compose blocks as JSX/TSX components; nice if message templates get complex enough to want component reuse.
- **Agent-authored markdown** — for LLM-generated replies, let the model write plain markdown and wrap it in a `markdown` block (post-2026 this covers tables + code); reserve hand-built block templates for structured alerts where layout must be exact.
- Templating-service perspective (structure vs. content separation): [SuprSend's Block Kit + JSONNET write-up](https://www.suprsend.com/post/customising-transactional-notifications-using-slack-block-kit-and-jsonnet-with-examples-from-jira).

## 6. Maple-specific ideas

- **Alert card v1:** severity color bar (attachment) + header + fields (service/env/threshold/current) + QuickChart-or-rendered sparkline + `View trace` / `Ack` / `Silence` buttons + context line with rule name and org.
- **Trace summary card:** when eve answers "why is checkout slow", reply with a markdown table of the top slow spans + a link per trace ID, code block for the offending query (`db.query.text` is already on spans).
- **Deploy correlation:** context block "⚙️ 2 deploys in window" with commit-SHA links — the ingest dummy data already carries commit SHAs.
- **Unfurls for Maple URLs** shared by humans: trace links → mini flamegraph stats card; dashboard links → title + last-24h sparkline.
- **Weekly digest:** one message per service group, markdown table (p95, error rate, Δ vs last week), rendered trend image.

## Further reading

- [Block Kit reference](https://docs.slack.dev/block-kit/) · [rich text block](https://docs.slack.dev/reference/block-kit/blocks/rich-text-block/) · [layouts guide](https://api.slack.com/messaging/composing/layouts)
- [March 2026 markdown-in-Block-Kit changelog](https://docs.slack.dev/changelog/2026/03/06/block-kit-rich-text/)
- [Knock: designing Slack notifications](https://knock.app/blog/the-guide-to-designing-slack-notifications) · [Knock: Block Kit deep dive](https://knock.app/blog/taking-a-deep-dive-into-slack-block-kit)
- [Slack app (marketplace) best practices](https://slack.dev/marketplace-best-practices/) — notification frequency, batching, threading guidance
- [Attachments → blocks migration](https://api.slack.com/messaging/attachments-to-blocks) (and the color-bar caveat)
- [QuickChart](https://quickchart.io/) · [Slack bot chart guide](https://quickchart.io/documentation/send-charts-with-slack-bot/) · [sparkline API](https://quickchart.io/documentation/sparkline-api/)
- [slack-block-builder](https://www.npmjs.com/package/slack-block-builder) · [jsx-slack](https://github.com/yhatt/jsx-slack)
- [Slack integration patterns for alerts & workflows](https://dev.to/rosgluk/slack-integration-patterns-for-alerts-and-workflows-1ij5)
