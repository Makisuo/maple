import { randomUUID } from "node:crypto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { defineInstrumentation, isChannel } from "eve/instrumentation";
import slackChannel from "#channels/slack.js";

/**
 * OpenTelemetry export to Maple's own ingest gateway — the eve-native port of
 * chat-flue's `setupTelemetry` (apps/chat-flue/src/lib/telemetry.ts). The
 * slack-agent is a long-running Node process on Railway, so a NodeSDK with the
 * default BatchSpanProcessor just works (none of chat-flue's workerd
 * flush/isolate pain applies).
 *
 * Disabled (no-op) when MAPLE_INGEST_KEY is unset, keeping local dev silent —
 * the same contract as chat-flue. `maple_org_id` is intentionally NOT set:
 * the ingest gateway strips client-supplied org attribution and injects it
 * from the ingest key.
 */

/** Service name stamped on every slack-agent span. */
export const SLACK_AGENT_SERVICE_NAME = "maple-slack-agent";

/** Default Maple ingest gateway (overridable via MAPLE_ENDPOINT). */
const DEFAULT_ENDPOINT = "https://ingest.maple.dev";

/**
 * Resource attributes mirroring chat-flue's telemetry.ts (exported for
 * tests). The deployment environment is dual-emitted: Tinybird MVs still
 * pre-extract the legacy `deployment.environment`; keep both it and the
 * OTel-canonical `.name` until the MVs coalesce them.
 */
export function buildResourceAttributes(
  environment: string | undefined,
): Record<string, string> {
  const attributes: Record<string, string> = {
    [ATTR_SERVICE_NAME]: SLACK_AGENT_SERVICE_NAME,
    "service.namespace": "backend",
    "service.instance.id": randomUUID(),
    "maple.sdk.type": "eve",
    "vcs.repository.url.full": "https://github.com/Makisuo/maple",
  };
  if (environment) {
    attributes["deployment.environment"] = environment;
    attributes["deployment.environment.name"] = environment;
  }
  return attributes;
}

function setupTelemetry(): void {
  const ingestKey = process.env.MAPLE_INGEST_KEY?.trim();
  if (!ingestKey) return;

  const endpoint = (
    process.env.MAPLE_ENDPOINT?.trim() || DEFAULT_ENDPOINT
  ).replace(/\/+$/u, "");
  const environment =
    process.env.MAPLE_ENVIRONMENT?.trim() ||
    process.env.RAILWAY_ENVIRONMENT_NAME?.trim() ||
    undefined;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes(buildResourceAttributes(environment)),
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
      headers: { Authorization: `Bearer ${ingestKey}` },
    }),
  });
  sdk.start();

  // Flush the batch processor on shutdown so the tail of a deploy's spans
  // isn't lost when Railway stops the container.
  process.once("SIGTERM", () => {
    void sdk.shutdown();
  });
}

export default defineInstrumentation({
  setup: () => setupTelemetry(),
  // Customer telemetry content must not land in spans: no message history,
  // no model outputs. Chat-flue's OTel observer omits content for the same
  // reason.
  recordInputs: false,
  recordOutputs: false,
  events: {
    "step.started"(input) {
      // Slack-only runtime context so per-workspace latency/failures are
      // queryable — the analog of chat-flue's `chat.turn` span attributes.
      if (!isChannel(input.channel, slackChannel)) return undefined;
      const metadata = input.channel.metadata;
      return {
        runtimeContext: {
          "maple.slack.team_id": metadata.teamId ?? "",
          "maple.slack.channel_id": metadata.channelId ?? "",
          "maple.slack.thread_ts": metadata.threadTs ?? "",
          "maple.slack.user_id": metadata.triggeringUserId ?? "",
        },
      };
    },
  },
});
