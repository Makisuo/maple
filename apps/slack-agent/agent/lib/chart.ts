/**
 * Pure SVG chart rendering for Slack replies (no DOM, no chart library).
 *
 * A Slack message can only show images, so `agent/tools/render_chart.ts`
 * renders one of these SVGs to PNG in-process (@resvg/resvg-js) and uploads it
 * to the thread. Single series, fixed to the Maple dark theme (a PNG has no
 * theme, and the product default is dark): the chart draws as a Maple card —
 * dark warm surface, hairline border, border/50 grid, muted axis ink, Geist
 * Mono type — with the series colored by the same semantic tokens the web
 * dashboards use (`packages/ui/src/styles/tokens.css`, `.dark` block).
 */

export type ChartKind = "line" | "area" | "bar";

export type ChartUnit =
  | "number"
  | "percent"
  | "duration_ms"
  | "bytes"
  | "requests_per_sec";

export interface ChartSpec {
  readonly title: string;
  readonly kind: ChartKind;
  readonly unit: ChartUnit;
  /** `[epochMillis, value]` points, ordered or not — rendering sorts them. */
  readonly points: ReadonlyArray<readonly [number, number]>;
}

// Maple dark-theme tokens, oklch → hex (resvg has no oklch parser). Sources
// are the `.dark` values in packages/ui/src/styles/tokens.css.
const COLORS = {
  /** --card oklch(0.224 0.009 75) — charts sit on cards in the product. */
  surface: "#1e1b17",
  /** --foreground oklch(0.91 0.016 74) */
  primaryInk: "#e8e0d6",
  /** --muted-foreground oklch(0.603 0.023 72) */
  muted: "#8a7f72",
  /** --border oklch(0.268 0.012 67); the grid uses it at 50% like the web. */
  border: "#2a2520",
} as const;

/**
 * Series color per unit, mirroring the web dashboards' semantic tokens:
 * latency → --chart-p95 amber, throughput → --chart-throughput purple,
 * error-rate percent → --chart-error red, bytes → --chart-4 teal,
 * plain counts → --chart-p50 blue.
 */
const SERIES_COLORS: Record<ChartUnit, string> = {
  duration_ms: "#e8872a",
  requests_per_sec: "#9281e1",
  percent: "#ef2e43",
  bytes: "#00aa9a",
  number: "#4a9eff",
};

const WIDTH = 720;
const HEIGHT = 320;
const PAD_TOP = 56;
const PAD_RIGHT = 20;
const PAD_BOTTOM = 40;
const PAD_LEFT = 64;

// Geist Mono is the Maple product font (--font-sans in tokens.css). The
// container converts the @fontsource woff2 to TTF at build time (Dockerfile);
// DejaVu Sans Mono is the guaranteed fallback from fonts-dejavu-core.
const FONT = `"Geist Mono", "Geist Mono Variable", "DejaVu Sans Mono", ui-monospace, monospace`;

// ── formatting ──────────────────────────────────────────────────────────────

const round = (n: number, digits = 1): string => {
  const s = n.toFixed(digits);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
};

/** Formats a value for axis labels and direct labels, unit-aware. */
export function formatValue(value: number, unit: ChartUnit): string {
  switch (unit) {
    case "percent":
      return `${round(value, Math.abs(value) < 1 ? 2 : 1)}%`;
    case "duration_ms":
      if (Math.abs(value) >= 60_000) return `${round(value / 60_000)} min`;
      if (Math.abs(value) >= 1000) return `${round(value / 1000)} s`;
      return `${round(value)} ms`;
    case "bytes": {
      const abs = Math.abs(value);
      if (abs >= 1024 ** 3) return `${round(value / 1024 ** 3)} GiB`;
      if (abs >= 1024 ** 2) return `${round(value / 1024 ** 2)} MiB`;
      if (abs >= 1024) return `${round(value / 1024)} KiB`;
      return `${round(value)} B`;
    }
    case "requests_per_sec":
      return `${formatValue(value, "number")}/s`;
    case "number": {
      const abs = Math.abs(value);
      if (abs >= 1_000_000) return `${round(value / 1_000_000)}M`;
      if (abs >= 1000) return `${round(value / 1000)}k`;
      return round(value, abs < 10 && !Number.isInteger(value) ? 1 : 0);
    }
  }
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

function formatTimestamp(ms: number, rangeMs: number): string {
  const d = new Date(ms);
  const hhmm = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  if (rangeMs <= 36 * 3_600_000) return hhmm;
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hhmm}`;
}

// ── scales ──────────────────────────────────────────────────────────────────

/** "Nice" tick values covering [0|min, max] — exported for tests. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  const lo = Math.min(0, min);
  const hi = max <= lo ? lo + 1 : max;
  const rawStep = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rawStep) ??
    10 * mag;
  const ticks: number[] = [];
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  for (let t = start; t <= end + step * 1e-9; t += step) {
    ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  }
  return ticks;
}

const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

// ── rendering ───────────────────────────────────────────────────────────────

/**
 * Renders the chart spec to a self-contained SVG string (720×320 viewBox).
 * Throws when there are no points.
 */
export function renderChartSvg(spec: ChartSpec): string {
  const points = [...spec.points].sort((a, b) => a[0] - b[0]);
  if (points.length === 0) throw new Error("render_chart needs at least one data point.");

  const values = points.map((p) => p[1]);
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const yMin = ticks[0]!;
  const yMax = ticks[ticks.length - 1]!;
  const tMin = points[0]![0];
  const tMax = points[points.length - 1]![0];
  const tRange = Math.max(1, tMax - tMin);

  const plotW = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const x = (t: number): number => PAD_LEFT + ((t - tMin) / tRange) * plotW;
  const y = (v: number): number =>
    PAD_TOP + plotH - ((v - yMin) / Math.max(1e-9, yMax - yMin)) * plotH;

  const series = SERIES_COLORS[spec.unit];

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">`,
    // Card canvas: --radius 8px rounded corners + hairline --border, like a
    // dashboard widget. Slack composes PNGs on light and dark backdrops alike;
    // the border keeps the card edge legible on both.
    `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" rx="8" fill="${COLORS.surface}" stroke="${COLORS.border}"/>`,
    `<text x="${PAD_LEFT}" y="30" font-family='${FONT}' font-size="16" font-weight="600" fill="${COLORS.primaryInk}">${esc(spec.title)}</text>`,
  );

  if (spec.kind === "area") {
    // Web charts fill areas with a vertical series gradient (VerticalGradient
    // in packages/ui, 0.8 → 0.1), not a flat tint.
    parts.push(
      `<defs><linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stop-color="${series}" stop-opacity="0.8"/><stop offset="95%" stop-color="${series}" stop-opacity="0.1"/></linearGradient></defs>`,
    );
  }

  // Recessive horizontal gridlines (border at 50%, matching the web's
  // stroke-border/50 grid; the baseline gets the full border) + muted y labels.
  for (const tick of ticks) {
    const ty = y(tick);
    const isBaseline = tick === yMin;
    parts.push(
      `<line x1="${PAD_LEFT}" y1="${ty}" x2="${WIDTH - PAD_RIGHT}" y2="${ty}" stroke="${COLORS.border}"${isBaseline ? "" : ' stroke-opacity="0.5"'} stroke-width="1"/>`,
      `<text x="${PAD_LEFT - 8}" y="${ty + 4}" text-anchor="end" font-family='${FONT}' font-size="12" fill="${COLORS.muted}">${esc(formatValue(tick, spec.unit))}</text>`,
    );
  }

  // Marks.
  if (spec.kind === "bar") {
    // Band placement (bars imply regular buckets): each point owns a slot,
    // with a ≥2px surface gap between bars and no overflow past the plot.
    const slot = plotW / points.length;
    const barW = Math.max(1, Math.min(slot - 2, 40));
    for (const [i, [, v]] of points.entries()) {
      const bx = PAD_LEFT + slot * (i + 0.5) - barW / 2;
      const by = y(Math.max(v, yMin));
      const bh = Math.max(1, y(yMin) - by);
      const r = Math.min(4, barW / 2, bh);
      parts.push(
        `<path d="M ${bx} ${by + bh} V ${by + r} Q ${bx} ${by} ${bx + r} ${by} H ${bx + barW - r} Q ${bx + barW} ${by} ${bx + barW} ${by + r} V ${by + bh} Z" fill="${series}"/>`,
      );
    }
  } else {
    const linePath = points
      .map(([t, v], i) => `${i === 0 ? "M" : "L"} ${x(t).toFixed(1)} ${y(v).toFixed(1)}`)
      .join(" ");
    if (spec.kind === "area") {
      parts.push(
        `<path d="${linePath} L ${x(tMax).toFixed(1)} ${y(yMin)} L ${x(tMin).toFixed(1)} ${y(yMin)} Z" fill="url(#areaFill)"/>`,
      );
    }
    parts.push(
      `<path d="${linePath}" fill="none" stroke="${series}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
    );
    // Selective direct label: the latest value, with a 2px surface ring dot.
    const [lt, lv] = points[points.length - 1]!;
    const anchor = x(lt) > WIDTH - PAD_RIGHT - 70 ? "end" : "start";
    const dx = anchor === "end" ? -8 : 8;
    parts.push(
      `<circle cx="${x(lt).toFixed(1)}" cy="${y(lv).toFixed(1)}" r="4" fill="${series}" stroke="${COLORS.surface}" stroke-width="2"/>`,
      `<text x="${(x(lt) + dx).toFixed(1)}" y="${(y(lv) - 8).toFixed(1)}" text-anchor="${anchor}" font-family='${FONT}' font-size="12" font-weight="600" fill="${COLORS.primaryInk}">${esc(formatValue(lv, spec.unit))}</text>`,
    );
  }

  // X labels: first / middle / last, muted, UTC.
  const xLabelY = HEIGHT - 14;
  const mid = points[Math.floor((points.length - 1) / 2)]![0];
  parts.push(
    `<text x="${PAD_LEFT}" y="${xLabelY}" font-family='${FONT}' font-size="12" fill="${COLORS.muted}">${esc(formatTimestamp(tMin, tRange))}</text>`,
  );
  if (points.length > 2 && mid !== tMin && mid !== tMax) {
    parts.push(
      `<text x="${x(mid).toFixed(1)}" y="${xLabelY}" text-anchor="middle" font-family='${FONT}' font-size="12" fill="${COLORS.muted}">${esc(formatTimestamp(mid, tRange))}</text>`,
    );
  }
  if (tMax !== tMin) {
    parts.push(
      `<text x="${WIDTH - PAD_RIGHT}" y="${xLabelY}" text-anchor="end" font-family='${FONT}' font-size="12" fill="${COLORS.muted}">${esc(formatTimestamp(tMax, tRange))} UTC</text>`,
    );
  }

  parts.push("</svg>");
  return parts.join("\n");
}

// ── fallback ────────────────────────────────────────────────────────────────

const SPARK_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/**
 * Unicode sparkline fallback for when rendering or uploading fails
 * (docs/slack-rich-notifications.md §3). Downsamples to at most 24 buckets.
 */
export function sparkline(values: readonly number[], maxBuckets = 24): string {
  if (values.length === 0) return "";
  const buckets: number[] = [];
  const size = Math.ceil(values.length / maxBuckets);
  for (let i = 0; i < values.length; i += size) {
    const slice = values.slice(i, i + size);
    buckets.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  const min = Math.min(...buckets);
  const max = Math.max(...buckets);
  const range = max - min;
  return buckets
    .map((v) => {
      const idx =
        range === 0
          ? 3
          : Math.min(
              SPARK_LEVELS.length - 1,
              Math.floor(((v - min) / range) * SPARK_LEVELS.length),
            );
      return SPARK_LEVELS[idx];
    })
    .join("");
}
