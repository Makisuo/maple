import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  renderChartToThread,
  type RenderChartDeps,
  type RenderChartInput,
  type RenderChartSession,
} from "./render-chart.js";
import type { UploadPngOptions } from "./slack-upload.js";

/**
 * The degrade path IS the feature here. `render_chart` is called when a trend
 * is the finding, so a thrown tool error costs the model an answer it already
 * has — every failure (no channel to post into, a native renderer that blew
 * up, an unlinked workspace, Slack refusing the upload) must come back as a
 * sparkline the model can inline instead. That is invisible in production: a
 * broken degrade shows up only as a chart that silently never appears.
 *
 * Deps are injected so none of this needs @resvg/resvg-js or a Slack
 * workspace; the tool file (agent/tools/render_chart.ts) is a thin adapter
 * over `renderChartToThread` and passes the real ones.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const INPUT: RenderChartInput = {
  title: "Checkout p95 latency",
  kind: "line",
  unit: "duration_ms",
  points: [
    [1_700_000_000_000, 120],
    [1_700_000_060_000, 240],
    [1_700_000_120_000, 900],
  ],
};

const SESSION: RenderChartSession = {
  id: "sess_1",
  attributes: {
    team_id: "T123",
    channel_id: "C123",
    thread_ts: "1700000000.000100",
  },
};

interface Recorder {
  readonly deps: RenderChartDeps;
  /** Titles of the specs handed to the renderer. */
  readonly renderCalls: string[];
  readonly tokenCalls: Array<{ teamId?: string; channelId?: string; threadTs?: string }>;
  readonly uploadCalls: UploadPngOptions[];
}

function makeDeps(overrides: Partial<RenderChartDeps> = {}): Recorder {
  const renderCalls: string[] = [];
  const tokenCalls: Recorder["tokenCalls"] = [];
  const uploadCalls: UploadPngOptions[] = [];
  const deps: RenderChartDeps = {
    async renderPng(spec) {
      renderCalls.push(spec.title);
      return PNG;
    },
    async resolveBotToken(context) {
      tokenCalls.push({ ...context });
      return "xoxb-team-a";
    },
    async uploadPngToThread(options) {
      uploadCalls.push(options);
      return { fileId: "F1", permalink: "https://acme.slack.com/files/F1" };
    },
    ...overrides,
  };
  return { deps, renderCalls, tokenCalls, uploadCalls };
}

// The degrade paths log; keep the noise out of the test output and assert the
// operator-facing log instead.
let errorSpy: ReturnType<typeof spyOn<Console, "error">>;

beforeEach(() => {
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

// ── the posting path ────────────────────────────────────────────────────────

describe("renderChartToThread", () => {
  test("uploads the rendered PNG into the session's thread", async () => {
    const { deps, tokenCalls, uploadCalls } = makeDeps();
    const result = await renderChartToThread(INPUT, SESSION, deps);

    expect(result).toEqual({
      posted: true,
      fileId: "F1",
      permalink: "https://acme.slack.com/files/F1",
      latest: "900 ms",
      note: "Chart posted to the thread as an image. Do not re-describe it point by point.",
    });

    // The bot token is resolved per team — this app serves every workspace
    // that installed the Slack app.
    expect(tokenCalls).toEqual([
      { teamId: "T123", channelId: "C123", threadTs: "1700000000.000100" },
    ]);
    expect(uploadCalls[0]).toMatchObject({
      botToken: "xoxb-team-a",
      channelId: "C123",
      threadTs: "1700000000.000100",
      filename: "checkout-p95-latency.png",
      title: "Checkout p95 latency",
      png: PNG,
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// ── the degrade paths ───────────────────────────────────────────────────────

describe("fallback", () => {
  test("degrades when the session has no channel to post into", async () => {
    const { deps, renderCalls, tokenCalls, uploadCalls } = makeDeps();
    const session: RenderChartSession = {
      id: "sess_1",
      attributes: { team_id: "T123" },
    };

    const result = await renderChartToThread(INPUT, session, deps);
    expect(result.posted).toBe(false);
    expect(result).toMatchObject({
      latest: "900 ms",
      note: "Chart image unavailable — include the sparkline and latest value in your reply instead.",
    });
    expect(result.posted === false && result.sparkline.length).toBe(3);

    // Nothing was rendered, no credential was resolved, nothing was uploaded:
    // with no channel there is no work worth doing.
    expect(renderCalls).toEqual([]);
    expect(tokenCalls).toEqual([]);
    expect(uploadCalls).toEqual([]);
    // Not an error — an empty channel_id is a shape of session, not a failure.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("an empty-string channel_id counts as no channel", async () => {
    const { deps } = makeDeps();
    const session: RenderChartSession = {
      id: "sess_1",
      attributes: { team_id: "T123", channel_id: "" },
    };
    expect((await renderChartToThread(INPUT, session, deps)).posted).toBe(false);
  });

  test("degrades when rendering the PNG throws", async () => {
    // The real renderer is a native module (@resvg/resvg-js) that can fail on
    // a font/platform issue at runtime, long after the build succeeded.
    const { deps, uploadCalls } = makeDeps({
      renderPng: async () => {
        throw new Error("resvg: no fonts found");
      },
    });

    const result = await renderChartToThread(INPUT, SESSION, deps);
    expect(result.posted).toBe(false);
    expect(result).toMatchObject({ latest: "900 ms" });
    expect(uploadCalls).toEqual([]);
    // The operator has to be able to see why no chart appeared.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("session=sess_1");
  });

  test("degrades when the workspace has no bot token (unlinked team)", async () => {
    const { deps, uploadCalls } = makeDeps({
      resolveBotToken: async () => {
        throw new Error("Slack team T123 is not linked to a Maple workspace.");
      },
    });

    expect((await renderChartToThread(INPUT, SESSION, deps)).posted).toBe(false);
    expect(uploadCalls).toEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test("degrades when Slack refuses the upload", async () => {
    const { deps } = makeDeps({
      uploadPngToThread: async () => {
        throw new Error("Slack files.completeUploadExternal failed: not_in_channel");
      },
    });

    const result = await renderChartToThread(INPUT, SESSION, deps);
    expect(result.posted).toBe(false);
    expect(result).toMatchObject({
      latest: "900 ms",
      note: "Chart image unavailable — include the sparkline and latest value in your reply instead.",
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test("the fallback reads the series in time order, not argument order", async () => {
    // The model may hand back rows in whatever order the query returned them;
    // "latest" must mean latest by timestamp or the reply states a wrong number.
    const { deps } = makeDeps({
      renderPng: async () => {
        throw new Error("render failed");
      },
    });
    const unordered: RenderChartInput = {
      ...INPUT,
      points: [
        [1_700_000_120_000, 900],
        [1_700_000_000_000, 120],
        [1_700_000_060_000, 240],
      ],
    };

    const result = await renderChartToThread(unordered, SESSION, deps);
    expect(result).toMatchObject({ posted: false, latest: "900 ms" });
    const ordered = await renderChartToThread(INPUT, SESSION, deps);
    expect(result.posted === false && result.sparkline).toBe(
      ordered.posted === false ? ordered.sparkline : "",
    );
  });

  test("a single-point series still degrades cleanly", async () => {
    const { deps } = makeDeps({
      renderPng: async () => {
        throw new Error("render failed");
      },
    });
    const single: RenderChartInput = {
      title: "Error rate",
      kind: "bar",
      unit: "percent",
      points: [[1_700_000_000_000, 4.25]],
    };

    const result = await renderChartToThread(single, SESSION, deps);
    expect(result).toMatchObject({ posted: false, latest: "4.3%" });
    expect(result.posted === false && result.sparkline.length).toBe(1);
  });
});
