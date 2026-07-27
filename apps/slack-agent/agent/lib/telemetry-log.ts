import { logs, SeverityNumber } from "@opentelemetry/api-logs";

/**
 * Structured agent logging — the eve-native port of chat-flue's
 * `emitTelemetryLog` (apps/chat-flue/src/lib/telemetry.ts).
 *
 * Two reasons this exists instead of bare `console.log`:
 *
 *  1. **Reachability.** These lines (turn outcomes, tool failures) are the
 *     primary signal for the "agent did nothing" failure mode. Left on stdout
 *     they die in Railway's log pane, which is not queryable and not where
 *     anyone looks. Routed through the OTel logger they land in Maple next to
 *     the spans they belong to, correlated by trace/span id.
 *  2. **Structure.** Interpolated `key=value` prose is not queryable at all;
 *     attributes are. The console fallback emits JSON for the same reason.
 *
 * The logger provider is registered by agent/instrumentation.ts (NodeSDK's
 * `logRecordProcessors`). Until it is — MAPLE_INGEST_KEY unset, i.e. local dev
 * — `@opentelemetry/api-logs` hands out a no-op logger that silently drops
 * everything, so we track activation explicitly and fall back to the console.
 */

/** Logger name; matches the service name stamped on the resource. */
const LOGGER_NAME = "maple-slack-agent";

let telemetryActive = false;

/** Called by agent/instrumentation.ts once the LoggerProvider is registered. */
export function markAgentTelemetryActive(): void {
  telemetryActive = true;
}

export type LogSeverity = "info" | "warn" | "error";

export type LogAttributes = Readonly<
  Record<string, string | number | boolean | undefined>
>;

const SEVERITY_NUMBERS: Record<LogSeverity, SeverityNumber> = {
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

/** Drops absent values so they never become empty-string attributes. */
function definedAttributes(
  attributes: LogAttributes,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Emits one structured log record. Exported to Maple when telemetry is on,
 * printed as a single JSON line otherwise.
 */
export function emitAgentLog(
  severity: LogSeverity,
  body: string,
  attributes: LogAttributes = {},
): void {
  const defined = definedAttributes(attributes);

  if (!telemetryActive) {
    const line = JSON.stringify({ severity, body, ...defined });
    if (severity === "error") console.error(line);
    else if (severity === "warn") console.warn(line);
    else console.log(line);
    return;
  }

  logs.getLogger(LOGGER_NAME).emit({
    severityNumber: SEVERITY_NUMBERS[severity],
    severityText: severity.toUpperCase(),
    body,
    // Trace correlation is added by the SDK from the active context, so unlike
    // chat-flue (Workers, manual span lookup) there is nothing to stitch here.
    attributes: defined,
  });
}
