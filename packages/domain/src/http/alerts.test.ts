import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { AlertDestinationCreateRequest } from "./alerts"

describe("AlertDestinationCreateRequest", () => {
  const encode = Schema.encodeUnknownSync(AlertDestinationCreateRequest)

  it("encodes plain slack destination payloads", () => {
    expect(
      encode({
        type: "slack",
        name: "Ops Slack",
        enabled: true,
        webhookUrl: "https://hooks.slack.com/services/T/B/X",
        channelLabel: "#ops-alerts",
      }),
    ).toEqual({
      type: "slack",
      name: "Ops Slack",
      enabled: true,
      webhookUrl: "https://hooks.slack.com/services/T/B/X",
      channelLabel: "#ops-alerts",
    })
  })

  it("encodes plain pagerduty and webhook destination payloads", () => {
    expect(
      encode({
        type: "pagerduty",
        name: "PagerDuty",
        enabled: true,
        integrationKey: "integration-key",
      }),
    ).toEqual({
      type: "pagerduty",
      name: "PagerDuty",
      enabled: true,
      integrationKey: "integration-key",
    })

    expect(
      encode({
        type: "webhook",
        name: "Webhook",
        enabled: true,
        url: "https://example.com/alerts",
        signingSecret: "secret",
      }),
    ).toEqual({
      type: "webhook",
      name: "Webhook",
      enabled: true,
      url: "https://example.com/alerts",
      signingSecret: "secret",
    })
  })
})
