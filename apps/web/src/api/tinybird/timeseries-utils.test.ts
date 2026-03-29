import { describe, expect, it } from "vite-plus/test";
import {
  buildBucketTimeline,
  computeBucketSeconds,
  toIsoBucket,
} from "@/api/tinybird/timeseries-utils";

describe("timeseries-utils", () => {
  it("normalizes Tinybird datetime strings as UTC buckets", () => {
    expect(toIsoBucket("2026-02-01 00:00:00")).toBe("2026-02-01T00:00:00.000Z");
    expect(toIsoBucket("2026-02-01T00:00:00Z")).toBe("2026-02-01T00:00:00.000Z");
  });

  it("builds deterministic bucket timelines", () => {
    expect(buildBucketTimeline("2026-02-01 00:00:00", "2026-02-01 00:10:00", 300)).toEqual([
      "2026-02-01T00:00:00.000Z",
      "2026-02-01T00:05:00.000Z",
      "2026-02-01T00:10:00.000Z",
    ]);
  });

  it("keeps auto bucket sizing deterministic for common ranges", () => {
    expect(computeBucketSeconds("2026-02-01 00:00:00", "2026-02-01 00:30:00")).toBe(300);
    expect(computeBucketSeconds("2026-02-01 00:00:00", "2026-02-01 01:00:00")).toBe(300);
    expect(computeBucketSeconds("2026-02-01 00:00:00", "2026-02-01 06:00:00")).toBe(900);
    expect(computeBucketSeconds("2026-02-01 00:00:00", "2026-02-02 00:00:00")).toBe(3600);
    expect(computeBucketSeconds("2026-02-01 00:00:00", "2026-02-08 00:00:00")).toBe(14400);
  });
});
