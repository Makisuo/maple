import { describe, expect, it } from "vite-plus/test";
import { buildTimeseriesQuerySpec, createQueryDraft } from "@/lib/query-builder/model";

describe("query-builder model bucket parsing", () => {
  it("defaults new drafts to auto-bucket", () => {
    expect(createQueryDraft(0).stepInterval).toBe("");
  });

  it("parses hour shorthand step intervals", () => {
    const query = {
      ...createQueryDraft(0),
      dataSource: "traces" as const,
      aggregation: "count",
      stepInterval: "1h",
    };

    const built = buildTimeseriesQuerySpec(query);
    expect(built.error).toBeNull();
    expect(built.query?.kind).toBe("timeseries");
    if (built.query?.kind !== "timeseries") {
      return;
    }

    expect(built.query.bucketSeconds).toBe(3600);
  });

  it("parses minute shorthand step intervals", () => {
    const query = {
      ...createQueryDraft(0),
      dataSource: "logs" as const,
      aggregation: "count",
      stepInterval: "5m",
    };

    const built = buildTimeseriesQuerySpec(query);
    expect(built.error).toBeNull();
    expect(built.query?.kind).toBe("timeseries");
    if (built.query?.kind !== "timeseries") {
      return;
    }

    expect(built.query.bucketSeconds).toBe(300);
  });

  it("keeps invalid shorthand as auto-bucket with warning", () => {
    const query = {
      ...createQueryDraft(0),
      dataSource: "traces" as const,
      aggregation: "count",
      stepInterval: "soon",
    };

    const built = buildTimeseriesQuerySpec(query);
    expect(built.error).toBeNull();
    expect(built.query?.kind).toBe("timeseries");
    if (built.query?.kind !== "timeseries") {
      return;
    }

    expect(built.query.bucketSeconds).toBeUndefined();
    expect(
      built.warnings.some((warning) => warning.includes("Invalid step interval ignored")),
    ).toBe(true);
  });
});
