import { describe, expect, test } from "bun:test";
import {
  formatValue,
  niceTicks,
  renderChartSvg,
  sparkline,
  type ChartSpec,
} from "./chart.js";

// ── formatValue ─────────────────────────────────────────────────────────────

describe("formatValue", () => {
  test("durations scale ms → s → min", () => {
    expect(formatValue(340, "duration_ms")).toBe("340 ms");
    expect(formatValue(1200, "duration_ms")).toBe("1.2 s");
    expect(formatValue(120_000, "duration_ms")).toBe("2 min");
  });

  test("percent keeps sub-1 precision", () => {
    expect(formatValue(2.13, "percent")).toBe("2.1%");
    expect(formatValue(0.42, "percent")).toBe("0.42%");
  });

  test("bytes scale binary", () => {
    expect(formatValue(512, "bytes")).toBe("512 B");
    expect(formatValue(2048, "bytes")).toBe("2 KiB");
    expect(formatValue(3 * 1024 ** 2, "bytes")).toBe("3 MiB");
  });

  test("numbers compact with k/M", () => {
    expect(formatValue(950, "number")).toBe("950");
    expect(formatValue(1200, "number")).toBe("1.2k");
    expect(formatValue(2_500_000, "number")).toBe("2.5M");
  });

  test("requests_per_sec appends /s", () => {
    expect(formatValue(1200, "requests_per_sec")).toBe("1.2k/s");
  });
});

// ── niceTicks ───────────────────────────────────────────────────────────────

describe("niceTicks", () => {
  test("always includes a zero baseline for positive data", () => {
    const ticks = niceTicks(12, 87);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]!).toBeGreaterThanOrEqual(87);
  });

  test("survives a flat series", () => {
    const ticks = niceTicks(5, 5);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks[ticks.length - 1]!).toBeGreaterThanOrEqual(5);
  });
});

// ── sparkline ───────────────────────────────────────────────────────────────

describe("sparkline", () => {
  test("maps min to the lowest bar and max to the highest", () => {
    const s = sparkline([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(s.startsWith("▁")).toBe(true);
    expect(s.endsWith("█")).toBe(true);
    expect(s).toHaveLength(8);
  });

  test("downsamples long series to 24 buckets", () => {
    const values = Array.from({ length: 500 }, (_, i) => Math.sin(i / 20));
    expect([...sparkline(values)].length).toBeLessThanOrEqual(24);
  });

  test("flat series renders mid-level bars, empty series renders nothing", () => {
    expect(sparkline([3, 3, 3])).toBe("▄▄▄");
    expect(sparkline([])).toBe("");
  });
});

// ── renderChartSvg ──────────────────────────────────────────────────────────

const T0 = Date.UTC(2026, 6, 23, 12, 0, 0);

const spec = (overrides: Partial<ChartSpec> = {}): ChartSpec => ({
  title: "Checkout p95 latency",
  kind: "line",
  unit: "duration_ms",
  points: Array.from(
    { length: 12 },
    (_, i) => [T0 + i * 300_000, 200 + i * 10] as const,
  ),
  ...overrides,
});

describe("renderChartSvg", () => {
  test("renders a titled SVG with unit-formatted axis labels", () => {
    const svg = renderChartSvg(spec());
    expect(svg).toStartWith("<svg");
    expect(svg).toContain("Checkout p95 latency");
    expect(svg).toContain("ms</text>"); // y-axis labels carry the unit
    expect(svg).toContain("UTC");
  });

  test("escapes markup in the title", () => {
    const svg = renderChartSvg(spec({ title: 'a<b>&"c"' }));
    expect(svg).toContain("a&lt;b&gt;&amp;&quot;c&quot;");
    expect(svg).not.toContain("<b>");
  });

  test("area charts add a gradient fill under the line", () => {
    const svg = renderChartSvg(spec({ kind: "area" }));
    expect(svg).toContain("<linearGradient");
    expect(svg).toContain('fill="url(#areaFill)"');
  });

  test("draws the Maple dark card surface", () => {
    const svg = renderChartSvg(spec());
    expect(svg).toContain('fill="#1e1b17"'); // --card (dark)
    expect(svg).toContain('stroke="#2a2520"'); // --border (dark)
    expect(svg).toContain("Geist Mono");
  });

  test("series color follows the unit's semantic token", () => {
    // latency → --chart-p95 amber; throughput → --chart-throughput purple
    expect(renderChartSvg(spec({ unit: "duration_ms" }))).toContain("#e8872a");
    expect(
      renderChartSvg(spec({ unit: "requests_per_sec" })),
    ).toContain("#9281e1");
  });

  test("bar charts render one path per point", () => {
    const svg = renderChartSvg(spec({ kind: "bar" }));
    expect(svg.match(/<path/gu)?.length).toBe(12);
  });

  test("throws on an empty series", () => {
    expect(() => renderChartSvg(spec({ points: [] }))).toThrow(
      "at least one data point",
    );
  });

  test("a single point renders without NaN geometry", () => {
    const svg = renderChartSvg(spec({ points: [[T0, 42]] }));
    expect(svg).not.toContain("NaN");
  });
});
