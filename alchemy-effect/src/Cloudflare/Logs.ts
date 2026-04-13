import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { LogLine, LogsInput } from "../Provider.ts";

const DEFAULT_LOOKBACK_MS = 1 * 60 * 60 * 1000;

export interface TelemetryFilter {
  key: string;
  operation:
    | "eq"
    | "neq"
    | "includes"
    | "not_includes"
    | "starts_with"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "in"
    | "not_in";
  type: "string" | "number" | "boolean";
  value?: string | number | boolean;
}

const parseEvents = (
  response: workers.QueryObservabilityTelemetryResponse,
): LogLine[] => {
  const lines: LogLine[] = [];
  if (response.events?.events) {
    for (const event of response.events.events) {
      const ts = new Date(event.timestamp);
      const meta = event.$metadata;
      const msg =
        meta.message ??
        (meta.level === "error"
          ? `error: ${meta.error ?? "unknown"}`
          : `${meta.level ?? "log"}`);
      lines.push({ timestamp: ts, message: msg });
    }
  }
  return lines;
};

export const CloudflareLogs = Effect.gen(function* () {
  const queryTelemetry = yield* workers.queryObservabilityTelemetry;

  const queryLogs = (opts: {
    accountId: string;
    filters: TelemetryFilter[];
    options: LogsInput;
  }) =>
    Effect.gen(function* () {
      const now = Date.now();
      const limit = opts.options.limit ?? 100;

      if (opts.options.since) {
        const response = yield* queryTelemetry({
          accountId: opts.accountId,
          queryId: "events",
          view: "events",
          timeframe: { from: opts.options.since.getTime(), to: now },
          limit,
          parameters: {
            filters: opts.filters,
            // orderBy: { value: "timestamp", order: "desc" },
          },
        });
        return parseEvents(response);
      }

      const response = yield* queryTelemetry({
        accountId: opts.accountId,
        queryId: "events",
        view: "events",
        timeframe: { from: now - DEFAULT_LOOKBACK_MS, to: now },
        limit,
        parameters: {
          filters: opts.filters,
        },
      });

      return parseEvents(response);
    });

  const tailStream = (opts: {
    accountId: string;
    filters: TelemetryFilter[];
  }) => {
    const poll = (since: number): Stream.Stream<LogLine, any> =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* Effect.sleep("2 seconds");
          const now = Date.now();

          const response = yield* queryTelemetry({
            accountId: opts.accountId,
            queryId: "events",
            view: "events",
            timeframe: { from: since, to: now },
            limit: 100,
            parameters: {
              filters: opts.filters,
              orderBy: { value: "timestamp", order: "asc" },
            },
          });

          const lines = parseEvents(response);
          const nextSince =
            lines.length > 0
              ? Math.max(...lines.map((l) => l.timestamp.getTime())) + 1
              : since;

          return Stream.concat(Stream.fromIterable(lines), poll(nextSince));
        }),
      );

    return poll(Date.now());
  };

  return { queryLogs, tailStream };
});
