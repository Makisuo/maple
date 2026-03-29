import { describe, it, expect } from "vite-plus/test";
import { markIncompleteSegments } from "../incomplete-buckets";

function makeRow(bucket: string, values: Record<string, number>): Record<string, unknown> {
  return { bucket, ...values };
}

/** Create an ISO timestamp `hoursAgo` hours before `now`. */
function hoursAgo(hours: number, now: number): string {
  return new Date(now - hours * 3600_000).toISOString();
}

describe("markIncompleteSegments", () => {
  it("returns data unchanged when all buckets are complete", () => {
    const now = Date.now();
    const data = [
      makeRow(hoursAgo(4, now), { throughput: 10 }),
      makeRow(hoursAgo(3, now), { throughput: 20 }),
      makeRow(hoursAgo(2, now), { throughput: 30 }),
    ];
    // Bucket interval = 1h; last bucket is 2h ago → 2h + 1h = 1h ago < now → all complete
    const result = markIncompleteSegments(data, ["throughput"], { now });

    expect(result.hasIncomplete).toBe(false);
    expect(result.incompleteKeys).toEqual([]);
    expect(result.data).toEqual(data);
  });

  it("marks the last bucket as incomplete", () => {
    const now = Date.now();
    const data = [
      makeRow(hoursAgo(3, now), { throughput: 10 }),
      makeRow(hoursAgo(2, now), { throughput: 20 }),
      makeRow(hoursAgo(1, now), { throughput: 30 }),
      // This bucket is only 0h ago → 0h + 1h = 1h from now > now → incomplete
      makeRow(hoursAgo(0, now), { throughput: 5 }),
    ];

    const result = markIncompleteSegments(data, ["throughput"], { now });

    expect(result.hasIncomplete).toBe(true);
    expect(result.incompleteKeys).toEqual(["throughput_incomplete"]);

    // First two: complete, no incomplete value
    expect(result.data[0].throughput).toBe(10);
    expect(result.data[0].throughput_incomplete).toBeNull();

    expect(result.data[1].throughput).toBe(20);
    expect(result.data[1].throughput_incomplete).toBeNull();

    // Bridge point (index 2): last complete bucket, has both values
    expect(result.data[2].throughput).toBe(30);
    expect(result.data[2].throughput_incomplete).toBe(30);

    // Incomplete bucket (index 3): value moved to _incomplete key
    expect(result.data[3].throughput).toBeNull();
    expect(result.data[3].throughput_incomplete).toBe(5);
  });

  it("handles multiple incomplete buckets", () => {
    const now = Date.now();
    // 30-minute intervals; last two buckets are within interval of now
    const data = [
      makeRow(hoursAgo(2, now), { v: 100 }),
      makeRow(hoursAgo(1.5, now), { v: 200 }),
      makeRow(hoursAgo(1, now), { v: 300 }),
      makeRow(hoursAgo(0.5, now), { v: 400 }),
      makeRow(hoursAgo(0, now), { v: 500 }),
    ];

    const result = markIncompleteSegments(data, ["v"], { now });

    expect(result.hasIncomplete).toBe(true);
    // Index 0,1,2 are complete (bucket + 30min < now)
    // Index 3: 0.5h ago + 0.5h = now → borderline, but > check should pass
    // Actually: 0.5h ago + 0.5h interval = exactly now, so NOT > now → complete
    // Index 4: 0h ago + 0.5h interval = 0.5h from now > now → incomplete

    // Bridge = index 3 (last complete)
    expect(result.data[3].v).not.toBeNull();
    expect(result.data[3].v_incomplete).not.toBeNull();

    // Index 4: incomplete
    expect(result.data[4].v).toBeNull();
    expect(result.data[4].v_incomplete).toBe(500);
  });

  it("handles all incomplete (first bucket is within interval)", () => {
    const now = Date.now();
    // Single bucket that's right now → bucket + interval > now
    // Need at least 2 points to infer interval, so create a contrived case
    const data = [makeRow(hoursAgo(0.5, now), { v: 10 }), makeRow(hoursAgo(0, now), { v: 20 })];
    // Interval = 0.5h = 30min
    // First: 0.5h ago + 0.5h = now → NOT > now (equal) → complete
    // Second: 0h ago + 0.5h = 0.5h from now → > now → incomplete

    const result = markIncompleteSegments(data, ["v"], { now });
    expect(result.hasIncomplete).toBe(true);

    // First is complete + bridge
    expect(result.data[0].v).toBe(10);
    expect(result.data[0].v_incomplete).toBe(10);

    // Second is incomplete
    expect(result.data[1].v).toBeNull();
    expect(result.data[1].v_incomplete).toBe(20);
  });

  it("handles single data point (cannot infer interval)", () => {
    const data = [makeRow("2026-01-01T00:00:00Z", { v: 42 })];
    const result = markIncompleteSegments(data, ["v"]);

    expect(result.hasIncomplete).toBe(false);
    expect(result.data).toEqual(data);
  });

  it("handles empty data", () => {
    const result = markIncompleteSegments([], ["v"]);

    expect(result.hasIncomplete).toBe(false);
    expect(result.data).toEqual([]);
    expect(result.incompleteKeys).toEqual([]);
  });

  it("handles multiple value keys", () => {
    const now = Date.now();
    const data = [
      makeRow(hoursAgo(2, now), { p50: 10, p95: 50, p99: 100 }),
      makeRow(hoursAgo(1, now), { p50: 12, p95: 55, p99: 110 }),
      makeRow(hoursAgo(0, now), { p50: 8, p95: 40, p99: 80 }),
    ];

    const result = markIncompleteSegments(data, ["p50", "p95", "p99"], { now });

    expect(result.hasIncomplete).toBe(true);
    expect(result.incompleteKeys).toEqual(["p50_incomplete", "p95_incomplete", "p99_incomplete"]);

    // Bridge point (index 1)
    expect(result.data[1].p50).toBe(12);
    expect(result.data[1].p50_incomplete).toBe(12);
    expect(result.data[1].p95).toBe(55);
    expect(result.data[1].p95_incomplete).toBe(55);
    expect(result.data[1].p99).toBe(110);
    expect(result.data[1].p99_incomplete).toBe(110);

    // Incomplete (index 2)
    expect(result.data[2].p50).toBeNull();
    expect(result.data[2].p50_incomplete).toBe(8);
    expect(result.data[2].p95).toBeNull();
    expect(result.data[2].p95_incomplete).toBe(40);
    expect(result.data[2].p99).toBeNull();
    expect(result.data[2].p99_incomplete).toBe(80);
  });
});
