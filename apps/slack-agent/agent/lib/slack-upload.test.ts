import { afterEach, describe, expect, test } from "bun:test";
import { installFetchStub, type FetchStub } from "./fetch-stub.js";
import { uploadPngToThread } from "./slack-upload.js";

/**
 * The three-step Slack external-upload flow is where the `render_chart` tool
 * either posts an image or degrades to a sparkline, and every step is a
 * separate network hop that can fail on its own. The tool swallows the
 * exception, so if a step is wired wrong (bad content-type, missing thread_ts,
 * a `{ok:false}` body read as success) nothing surfaces except a chart that
 * never appears. These tests pin each hop's request and each failure mode.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

const UPLOAD_URL = "https://files.slack.com/upload/v1/abc123";

const OPTIONS = {
  botToken: "xoxb-team-a",
  channelId: "C123",
  threadTs: "1700000000.000100",
  filename: "checkout-p95-latency.png",
  title: "Checkout p95 latency",
  png: PNG,
};

let stub: FetchStub | undefined;

/** Responds per Slack endpoint; `overrides` replaces one step's response. */
function stubSlack(
  overrides: Partial<Record<"getUrl" | "upload" | "complete", () => Response>> = {},
): FetchStub {
  stub = installFetchStub((url) => {
    if (url.endsWith("/files.getUploadURLExternal")) {
      return (
        overrides.getUrl?.() ??
        Response.json({ ok: true, upload_url: UPLOAD_URL, file_id: "F1" })
      );
    }
    if (url === UPLOAD_URL) {
      return overrides.upload?.() ?? new Response("OK");
    }
    if (url.endsWith("/files.completeUploadExternal")) {
      return (
        overrides.complete?.() ??
        Response.json({
          ok: true,
          files: [{ id: "F1", permalink: "https://acme.slack.com/files/F1" }],
        })
      );
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  return stub;
}

afterEach(() => {
  stub?.restore();
  stub = undefined;
});

describe("uploadPngToThread", () => {
  test("walks getUploadURLExternal → PUT bytes → completeUploadExternal", async () => {
    const calls = stubSlack().calls;

    const result = await uploadPngToThread(OPTIONS);

    expect(result).toEqual({
      fileId: "F1",
      permalink: "https://acme.slack.com/files/F1",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://slack.com/api/files.getUploadURLExternal",
      UPLOAD_URL,
      "https://slack.com/api/files.completeUploadExternal",
    ]);

    // Step 1: form-encoded, per-team token, byte length Slack pre-allocates on.
    const [getUrl, upload, complete] = calls;
    expect(getUrl?.headers.authorization).toBe("Bearer xoxb-team-a");
    expect(getUrl?.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const form = new URLSearchParams(String(getUrl?.body));
    expect(form.get("filename")).toBe("checkout-p95-latency.png");
    expect(form.get("length")).toBe(String(PNG.byteLength));

    // Step 2: raw bytes to the returned URL — no Slack token on this hop.
    expect(upload?.headers["content-type"]).toBe("image/png");
    expect(upload?.headers.authorization).toBeUndefined();

    // Step 3: JSON, and the share target is what puts the image IN the thread.
    expect(complete?.headers["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
    expect(JSON.parse(String(complete?.body))).toEqual({
      files: [{ id: "F1", title: "Checkout p95 latency" }],
      channel_id: "C123",
      thread_ts: "1700000000.000100",
    });
  });

  test("omits thread_ts when posting to a channel root", async () => {
    const calls = stubSlack().calls;
    const { threadTs: _threadTs, ...withoutThread } = OPTIONS;

    await uploadPngToThread(withoutThread);

    expect(JSON.parse(String(calls[2]?.body))).not.toHaveProperty("thread_ts");
  });

  test("tolerates a completed upload that reports no permalink", async () => {
    stubSlack({ complete: () => Response.json({ ok: true, files: [{ id: "F1" }] }) });
    expect(await uploadPngToThread(OPTIONS)).toEqual({
      fileId: "F1",
      permalink: null,
    });
  });

  // ── failure per step ──────────────────────────────────────────────────────

  test("throws when getUploadURLExternal returns a non-2xx", async () => {
    stubSlack({ getUrl: () => new Response(null, { status: 502 }) });
    await expect(uploadPngToThread(OPTIONS)).rejects.toThrow(
      /files.getUploadURLExternal failed: HTTP 502/,
    );
  });

  test("throws on a 200 { ok: false } from getUploadURLExternal", async () => {
    // Slack signals most application errors with HTTP 200 — reading only
    // `res.ok` would treat this as success and upload into the void.
    stubSlack({
      getUrl: () => Response.json({ ok: false, error: "invalid_auth" }),
    });
    await expect(uploadPngToThread(OPTIONS)).rejects.toThrow(
      /files.getUploadURLExternal failed: invalid_auth/,
    );
  });

  test("throws when the byte upload fails", async () => {
    const { calls } = stubSlack({
      upload: () => new Response(null, { status: 413 }),
    });
    await expect(uploadPngToThread(OPTIONS)).rejects.toThrow(
      /Slack file upload failed: HTTP 413/,
    );
    // …and does not try to complete an upload that never landed.
    expect(calls).toHaveLength(2);
  });

  test("throws when completeUploadExternal reports an error", async () => {
    stubSlack({
      complete: () => Response.json({ ok: false, error: "not_in_channel" }),
    });
    await expect(uploadPngToThread(OPTIONS)).rejects.toThrow(
      /files.completeUploadExternal failed: not_in_channel/,
    );
  });

  test("throws with a generic reason when Slack omits the error field", async () => {
    stubSlack({ complete: () => Response.json({ ok: false }) });
    await expect(uploadPngToThread(OPTIONS)).rejects.toThrow(/unknown_error/);
  });
});
