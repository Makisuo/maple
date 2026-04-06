import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

// --- Mock effect-utils BEFORE importing anything that uses it ---
const executeQueryEngineMock = vi.fn()
const runTinybirdQueryMock = vi.fn()

vi.mock("@/api/tinybird/effect-utils", async () => {
  const actual = await vi.importActual<typeof import("@/api/tinybird/effect-utils")>(
    "@/api/tinybird/effect-utils",
  )
  return {
    ...actual,
    executeQueryEngine: (...args: unknown[]) => executeQueryEngineMock(...args),
    runTinybirdQuery: (...args: unknown[]) => runTinybirdQueryMock(...args),
  }
})

// Default mock implementations
executeQueryEngineMock.mockImplementation((operation: string) => {
  if (operation.includes("listTraces")) {
    return Effect.succeed({
      result: {
        kind: "list",
        source: "traces",
        data: [
          {
            traceId: "t1",
            timestamp: "2026-03-28 00:00:00",
            durationMs: 142,
            serviceName: "api-gw",
            spanName: "GET /api/users",
            spanKind: "SERVER",
            statusCode: "Ok",
            hasError: 0,
            spanAttributes: {
              "http.method": "GET",
              "http.route": "/api/users",
              "http.status_code": "200",
            },
          },
        ],
      },
    })
  }
  // Default: empty list
  return Effect.succeed({ result: { kind: "list", source: "traces", data: [] } })
})

runTinybirdQueryMock.mockImplementation(() =>
  Effect.succeed({
    data: [
      {
        timestamp: "2026-03-28 12:00:00",
        severityText: "ERROR",
        severityNumber: 17,
        serviceName: "api-gw",
        body: "Connection refused",
        traceId: "t1",
        spanId: "s1",
        logAttributes: '{"http.method":"GET"}',
        resourceAttributes: '{"service.version":"1.0"}',
      },
    ],
  }),
)

// --- Now import production code ---
import { listTraces } from "@/api/tinybird/traces";
import { listLogs } from "@/api/tinybird/logs";
import { serverFunctionMap } from "@/components/dashboard-builder/data-source-registry";
import { resolveFieldPath } from "@/lib/resolve-field-path";

// -------------------------------------------------------------------------
// 1. Verify listTraces works with exactly the params a list widget sends
// -------------------------------------------------------------------------
describe("list widget data flow", () => {
  it("listTraces succeeds with list widget params (no filter)", async () => {
    const params = {
      startTime: "2026-03-28 00:00:00",
      endTime: "2026-03-28 23:59:59",
      limit: 25,
    };

    const result = await Effect.runPromise(listTraces({ data: params }));

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      traceId: "t1",
      rootSpanName: "GET /api/users",
      durationMs: 142,
      hasError: false,
    });
  });

  it("listTraces succeeds with filter params", async () => {
    const params = {
      startTime: "2026-03-28 00:00:00",
      endTime: "2026-03-28 23:59:59",
      limit: 50,
      service: "api-gw",
      hasError: true,
    };

    const result = await Effect.runPromise(listTraces({ data: params }));
    expect(result.data).toBeDefined();
  });

  it("listLogs succeeds with list widget params", async () => {
    const params = {
      startTime: "2026-03-28 00:00:00",
      endTime: "2026-03-28 23:59:59",
      limit: 25,
    };

    const result = await Effect.runPromise(listLogs({ data: params }));

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      severityText: "ERROR",
      serviceName: "api-gw",
      body: "Connection refused",
      logAttributes: { "http.method": "GET" },
    });
  });

  // -----------------------------------------------------------------------
  // 2. Verify serverFunctionMap contains list endpoints
  // -----------------------------------------------------------------------
  it("serverFunctionMap has list_traces", () => {
    expect(serverFunctionMap.list_traces).toBeDefined();
    expect(typeof serverFunctionMap.list_traces).toBe("function");
  });

  it("serverFunctionMap has list_logs", () => {
    expect(serverFunctionMap.list_logs).toBeDefined();
    expect(typeof serverFunctionMap.list_logs).toBe("function");
  });

  // -----------------------------------------------------------------------
  // 3. Verify the full atom-like call path:
  //    serverFn({ data: params }) → response.data extraction
  // -----------------------------------------------------------------------
  it("serverFunctionMap.list_traces({ data }) returns { data: Trace[] }", async () => {
    const serverFn = serverFunctionMap.list_traces;
    const params = {
      startTime: "2026-03-28 00:00:00",
      endTime: "2026-03-28 23:59:59",
      limit: 25,
    };

    const response = await Effect.runPromise(
      (serverFn({ data: params }) as Effect.Effect<unknown, unknown, never>).pipe(
        Effect.map((res) => {
          // This is what widgetFetchAtom does:
          return (res as { data?: unknown })?.data ?? res;
        }),
      ),
    );

    // After .data extraction, should be an array of Trace objects
    expect(Array.isArray(response)).toBe(true);
    const rows = response as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty("traceId");
    expect(rows[0]).toHaveProperty("rootSpanName");
  });

  it("serverFunctionMap.list_logs({ data }) returns { data: Log[] }", async () => {
    const serverFn = serverFunctionMap.list_logs;
    const params = {
      startTime: "2026-03-28 00:00:00",
      endTime: "2026-03-28 23:59:59",
      limit: 25,
    };

    const response = await Effect.runPromise(
      (serverFn({ data: params }) as Effect.Effect<unknown, unknown, never>).pipe(
        Effect.map((res) => {
          return (res as { data?: unknown })?.data ?? res;
        }),
      ),
    );

    expect(Array.isArray(response)).toBe(true);
    const rows = response as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty("severityText");
    expect(rows[0]).toHaveProperty("serviceName");
  });
});

// -------------------------------------------------------------------------
// 4. Simulate the exact widgetFetchAtom flow (JSON key roundtrip)
// -------------------------------------------------------------------------
describe("widgetFetchAtom simulation", () => {
  function normalizeForKey(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(normalizeForKey);
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = normalizeForKey(v);
    return out;
  }
  function encodeKey(value: unknown): string {
    const n = normalizeForKey(value);
    return JSON.stringify(n === undefined ? null : n);
  }

  it("list_traces: full atom roundtrip succeeds", async () => {
    // 1. Build params like useWidgetData does
    const resolvedTimeRange = { startTime: "2026-03-28 00:00:00", endTime: "2026-03-28 23:59:59" };
    const widgetParams = { limit: 25 }; // from list preset
    const resolvedParams: Record<string, unknown> = {
      startTime: resolvedTimeRange.startTime,
      endTime: resolvedTimeRange.endTime,
      ...widgetParams,
    };

    // 2. Encode key like widgetFetchAtom
    const key = encodeKey({ endpoint: "list_traces", params: resolvedParams });

    // 3. Parse key like atom does
    const { endpoint, params } = JSON.parse(key) as {
      endpoint: string;
      params: Record<string, unknown>;
    };

    expect(endpoint).toBe("list_traces");
    expect(params.startTime).toBe("2026-03-28 00:00:00");
    expect(params.endTime).toBe("2026-03-28 23:59:59");
    expect(params.limit).toBe(25);

    // 4. Call server function like atom does
    const serverFn = serverFunctionMap[endpoint as keyof typeof serverFunctionMap];
    expect(serverFn).toBeDefined();

    const result = await Effect.runPromise(
      (serverFn!({ data: params }) as Effect.Effect<unknown, unknown, never>).pipe(
        Effect.map((res) => (res as { data?: unknown })?.data ?? res),
      ),
    );

    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBeGreaterThan(0);
  });

  it("list_logs: full atom roundtrip succeeds", async () => {
    const resolvedTimeRange = { startTime: "2026-03-28 00:00:00", endTime: "2026-03-28 23:59:59" };
    const widgetParams = { limit: 25 };
    const resolvedParams: Record<string, unknown> = {
      startTime: resolvedTimeRange.startTime,
      endTime: resolvedTimeRange.endTime,
      ...widgetParams,
    };

    const key = encodeKey({ endpoint: "list_logs", params: resolvedParams });
    const { endpoint, params } = JSON.parse(key);
    const serverFn = serverFunctionMap[endpoint as keyof typeof serverFunctionMap];

    const result = await Effect.runPromise(
      (serverFn!({ data: params }) as Effect.Effect<unknown, unknown, never>).pipe(
        Effect.map((res) => (res as { data?: unknown })?.data ?? res),
      ),
    );

    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------------
// 5. Test buildWidgetDataSource for list
// -------------------------------------------------------------------------
describe("buildWidgetDataSource for list", () => {
  // Import dynamically to avoid circular dependency issues
  it("produces correct data source from list state", async () => {
    // Simulate what widget-query-builder-page does
    const {
      parseWhereClause,
      normalizeKey: normKey,
      parseBoolean: parseBool,
    } = await import("@maple/query-engine/where-clause");

    function buildListEndpointParams(
      dataSource: "traces" | "logs",
      whereClause: string,
      limit: number,
    ): Record<string, unknown> {
      const { clauses } = parseWhereClause(whereClause);
      const params: Record<string, unknown> = { limit };
      if (dataSource === "traces") {
        for (const clause of clauses) {
          const key = normKey(clause.key);
          if (key === "service.name") params.service = clause.value;
          else if (key === "span.name") params.spanName = clause.value;
          else if (key === "has_error") {
            const b = parseBool(clause.value);
            if (b != null) params.hasError = b;
          }
        }
      } else {
        for (const clause of clauses) {
          const key = normKey(clause.key);
          if (key === "service.name") params.service = clause.value;
          else if (key === "severity") params.severity = clause.value;
        }
      }
      return params;
    }

    // Test with empty where clause
    const params1 = buildListEndpointParams("traces", "", 50);
    expect(params1).toEqual({ limit: 50 });

    // Test with service filter
    const params2 = buildListEndpointParams("traces", 'service.name = "api-gw"', 25);
    expect(params2).toEqual({ limit: 25, service: "api-gw" });

    // Test with has_error filter
    const params3 = buildListEndpointParams("traces", "has_error = true", 25);
    expect(params3).toEqual({ limit: 25, hasError: true });

    // Test logs
    const params4 = buildListEndpointParams("logs", 'severity = "ERROR"', 50);
    expect(params4).toEqual({ limit: 50, severity: "ERROR" });

    // All of these should work with listTraces/listLogs
    for (const [fn, p] of [
      [
        serverFunctionMap.list_traces,
        { ...params1, startTime: "2026-03-28 00:00:00", endTime: "2026-03-28 23:59:59" },
      ],
      [
        serverFunctionMap.list_traces,
        { ...params2, startTime: "2026-03-28 00:00:00", endTime: "2026-03-28 23:59:59" },
      ],
      [
        serverFunctionMap.list_traces,
        { ...params3, startTime: "2026-03-28 00:00:00", endTime: "2026-03-28 23:59:59" },
      ],
      [
        serverFunctionMap.list_logs,
        { ...params4, startTime: "2026-03-28 00:00:00", endTime: "2026-03-28 23:59:59" },
      ],
    ] as const) {
      const result = await Effect.runPromise(
        fn({ data: p }) as Effect.Effect<unknown, unknown, never>,
      );
      expect(result).toHaveProperty("data");
    }
  });
});

// -------------------------------------------------------------------------
// 6. resolveFieldPath tests
// -------------------------------------------------------------------------
describe("resolveFieldPath", () => {
  const traceRow = {
    traceId: "t1",
    durationMs: 142,
    hasError: false,
    services: ["api-gw", "user-svc"],
    rootSpan: {
      name: "GET /api/users",
      kind: "SERVER",
      statusCode: "Ok",
      attributes: {
        "http.method": "GET",
        "http.route": "/api/users",
        "http.status_code": "200",
      },
    },
  };

  const logRow = {
    timestamp: "2026-03-28 12:00:00",
    severityText: "ERROR",
    serviceName: "api-gw",
    body: "Connection refused",
    logAttributes: { "http.method": "GET", "error.type": "ConnectionError" },
    resourceAttributes: { "service.version": "1.0", "deployment.environment": "prod" },
  };

  it("resolves top-level fields", () => {
    expect(resolveFieldPath(traceRow, "traceId")).toBe("t1");
    expect(resolveFieldPath(traceRow, "durationMs")).toBe(142);
    expect(resolveFieldPath(traceRow, "hasError")).toBe(false);
  });

  it("resolves nested object fields", () => {
    expect(resolveFieldPath(traceRow, "rootSpan.name")).toBe("GET /api/users");
    expect(resolveFieldPath(traceRow, "rootSpan.statusCode")).toBe("Ok");
  });

  it("resolves rootSpan.attributes with dotted keys", () => {
    expect(resolveFieldPath(traceRow, "rootSpan.attributes.http.method")).toBe("GET");
    expect(resolveFieldPath(traceRow, "rootSpan.attributes.http.route")).toBe("/api/users");
    expect(resolveFieldPath(traceRow, "rootSpan.attributes.http.status_code")).toBe("200");
  });

  it("resolves logAttributes with dotted keys", () => {
    expect(resolveFieldPath(logRow, "logAttributes.http.method")).toBe("GET");
    expect(resolveFieldPath(logRow, "logAttributes.error.type")).toBe("ConnectionError");
  });

  it("resolves resourceAttributes with dotted keys", () => {
    expect(resolveFieldPath(logRow, "resourceAttributes.service.version")).toBe("1.0");
    expect(resolveFieldPath(logRow, "resourceAttributes.deployment.environment")).toBe("prod");
  });

  it("returns undefined for missing fields", () => {
    expect(resolveFieldPath(traceRow, "nonexistent")).toBeUndefined();
    expect(resolveFieldPath(traceRow, "rootSpan.attributes.nonexistent.key")).toBeUndefined();
    expect(resolveFieldPath(logRow, "logAttributes.nonexistent.key")).toBeUndefined();
  });

  it("resolves array fields", () => {
    expect(resolveFieldPath(traceRow, "services")).toEqual(["api-gw", "user-svc"]);
  });
});
