import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { createHmac } from "node:crypto";

// maple.ts reads its env vars lazily (inside functions), but set dummies up
// front anyway so no test can accidentally depend on the developer's shell or
// .env.local values.
process.env.MAPLE_API_BASE_URL = "https://maple-api.test";
process.env.MAPLE_INTERNAL_SERVICE_TOKEN = "test-service-token";
delete process.env.SLACK_BOT_TOKEN;

import {
  resetWorkspaceCacheForTests,
  resolveBotToken,
  resolveWorkspace,
  verifySlackV0Signature,
} from "./maple.js";

// ── verifySlackV0Signature ──────────────────────────────────────────────────

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

function sign(body: string, timestamp: string, secret = SIGNING_SECRET): string {
  return (
    "v0=" +
    createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")
  );
}

function slackHeaders(signature: string | null, timestamp: string | null): Headers {
  const headers = new Headers();
  if (signature !== null) headers.set("x-slack-signature", signature);
  if (timestamp !== null) headers.set("x-slack-request-timestamp", timestamp);
  return headers;
}

describe("verifySlackV0Signature", () => {
  afterEach(() => {
    setSystemTime(); // restore real clock
  });

  test("accepts a valid signature", () => {
    const body = JSON.stringify({ type: "event_callback", team_id: "T123" });
    const ts = String(Math.floor(Date.now() / 1000));
    expect(
      verifySlackV0Signature(body, slackHeaders(sign(body, ts), ts), SIGNING_SECRET),
    ).toBe(true);
  });

  test("rejects a wrong signature (tampered body)", () => {
    const body = JSON.stringify({ type: "event_callback", team_id: "T123" });
    const ts = String(Math.floor(Date.now() / 1000));
    const signatureForOtherBody = sign(`${body} `, ts);
    expect(
      verifySlackV0Signature(
        body,
        slackHeaders(signatureForOtherBody, ts),
        SIGNING_SECRET,
      ),
    ).toBe(false);
  });

  test("rejects a signature made with a different secret", () => {
    const body = "payload";
    const ts = String(Math.floor(Date.now() / 1000));
    expect(
      verifySlackV0Signature(
        body,
        slackHeaders(sign(body, ts, "another-secret"), ts),
        SIGNING_SECRET,
      ),
    ).toBe(false);
  });

  test("rejects a timestamp outside the 5-minute skew window", () => {
    const body = "payload";
    const staleTs = String(Math.floor(Date.now() / 1000) - (5 * 60 + 1));
    expect(
      verifySlackV0Signature(body, slackHeaders(sign(body, staleTs), staleTs), SIGNING_SECRET),
    ).toBe(false);
  });

  test("accepts a timestamp just inside the skew window", () => {
    const body = "payload";
    const ts = String(Math.floor(Date.now() / 1000) - (5 * 60 - 5));
    expect(
      verifySlackV0Signature(body, slackHeaders(sign(body, ts), ts), SIGNING_SECRET),
    ).toBe(true);
  });

  test("rejects when the signature header is missing", () => {
    const body = "payload";
    const ts = String(Math.floor(Date.now() / 1000));
    expect(verifySlackV0Signature(body, slackHeaders(null, ts), SIGNING_SECRET)).toBe(
      false,
    );
  });

  test("rejects when the timestamp header is missing", () => {
    const body = "payload";
    const sig = sign(body, "12345");
    expect(verifySlackV0Signature(body, slackHeaders(sig, null), SIGNING_SECRET)).toBe(
      false,
    );
  });

  test("rejects a non-numeric timestamp", () => {
    const body = "payload";
    const ts = "not-a-number";
    expect(
      verifySlackV0Signature(body, slackHeaders(sign(body, ts), ts), SIGNING_SECRET),
    ).toBe(false);
  });
});

// ── resolveWorkspace: TTL cache + in-flight de-dupe ─────────────────────────

const WORKSPACE_PAYLOAD = {
  orgId: "org_1",
  teamId: "T1",
  teamName: "Acme",
  botToken: "xoxb-test",
  mapleApiKey: "maple_ak_test",
};

interface FetchStub {
  calls: { url: string; headers: Record<string, string> }[];
  respond: (url: string) => Response | Promise<Response>;
}

const realFetch = globalThis.fetch;

function installFetchStub(
  respond: (url: string) => Response | Promise<Response>,
): FetchStub {
  const stub: FetchStub = { calls: [], respond };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    stub.calls.push({ url, headers });
    return stub.respond(url);
  }) as typeof fetch;
  return stub;
}

describe("resolveWorkspace", () => {
  const T0 = new Date("2026-07-21T12:00:00Z");

  beforeAll(() => {
    process.env.MAPLE_API_BASE_URL = "https://maple-api.test";
    process.env.MAPLE_INTERNAL_SERVICE_TOKEN = "test-service-token";
  });

  beforeEach(() => {
    resetWorkspaceCacheForTests();
    setSystemTime(T0);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    setSystemTime();
  });

  test("resolves and caches a positive result for ~5 minutes", async () => {
    const stub = installFetchStub(() => Response.json(WORKSPACE_PAYLOAD));

    const first = await resolveWorkspace("T1");
    expect(first).toEqual(WORKSPACE_PAYLOAD);
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0]?.url).toBe(
      "https://maple-api.test/internal/slack/workspaces/T1",
    );
    expect(stub.calls[0]?.headers.authorization).toBe(
      "Bearer maple_svc_test-service-token",
    );

    // Still cached just before the 5-minute TTL.
    setSystemTime(new Date(T0.getTime() + 5 * 60_000 - 1000));
    expect(await resolveWorkspace("T1")).toEqual(WORKSPACE_PAYLOAD);
    expect(stub.calls.length).toBe(1);

    // Expired after the TTL → refetches.
    setSystemTime(new Date(T0.getTime() + 5 * 60_000 + 1000));
    expect(await resolveWorkspace("T1")).toEqual(WORKSPACE_PAYLOAD);
    expect(stub.calls.length).toBe(2);
  });

  test("caches a negative (404) result for ~30 seconds", async () => {
    const stub = installFetchStub(() => new Response(null, { status: 404 }));

    expect(await resolveWorkspace("T404")).toBeNull();
    expect(stub.calls.length).toBe(1);

    // Still cached just before the 30-second negative TTL.
    setSystemTime(new Date(T0.getTime() + 29_000));
    expect(await resolveWorkspace("T404")).toBeNull();
    expect(stub.calls.length).toBe(1);

    // Expired → refetches, picking up a fresh install quickly.
    setSystemTime(new Date(T0.getTime() + 31_000));
    stub.respond = () => Response.json(WORKSPACE_PAYLOAD);
    expect(await resolveWorkspace("T404")).toEqual({
      ...WORKSPACE_PAYLOAD,
      teamId: "T1",
    });
    expect(stub.calls.length).toBe(2);
  });

  test("negative TTL is shorter than positive TTL", async () => {
    const stub = installFetchStub(() => new Response(null, { status: 404 }));
    await resolveWorkspace("T404");

    // At +1 minute a positive entry would still be cached; the negative one
    // must already be gone.
    setSystemTime(new Date(T0.getTime() + 60_000));
    await resolveWorkspace("T404");
    expect(stub.calls.length).toBe(2);
  });

  test("does not cache 5xx errors as 'not installed'", async () => {
    const stub = installFetchStub(() => new Response(null, { status: 503 }));

    await expect(resolveWorkspace("T1")).rejects.toThrow(/HTTP 503/);

    // Next call retries immediately instead of serving a cached failure.
    stub.respond = () => Response.json(WORKSPACE_PAYLOAD);
    expect(await resolveWorkspace("T1")).toEqual(WORKSPACE_PAYLOAD);
    expect(stub.calls.length).toBe(2);
  });

  test("de-dupes concurrent resolves for the same team into one fetch", async () => {
    let release!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const stub = installFetchStub(() => gate);

    const a = resolveWorkspace("T1");
    const b = resolveWorkspace("T1");
    // Both calls issued while the first fetch is still in flight.
    expect(stub.calls.length).toBe(1);

    release(Response.json(WORKSPACE_PAYLOAD));
    const [resultA, resultB] = await Promise.all([a, b]);
    expect(resultA).toEqual(WORKSPACE_PAYLOAD);
    expect(resultB).toEqual(WORKSPACE_PAYLOAD);
    expect(stub.calls.length).toBe(1);

    // After settling, the in-flight entry is cleared and the cache serves.
    expect(await resolveWorkspace("T1")).toEqual(WORKSPACE_PAYLOAD);
    expect(stub.calls.length).toBe(1);
  });

  test("does not de-dupe across different teams", async () => {
    const stub = installFetchStub((url) =>
      Response.json({ ...WORKSPACE_PAYLOAD, teamId: url.split("/").at(-1) }),
    );

    const [a, b] = await Promise.all([resolveWorkspace("T1"), resolveWorkspace("T2")]);
    expect(stub.calls.length).toBe(2);
    expect(a?.teamId).toBe("T1");
    expect(b?.teamId).toBe("T2");
  });

  test("rejects incomplete resolve payloads", async () => {
    installFetchStub(() => Response.json({ orgId: "org_1" }));
    await expect(resolveWorkspace("T1")).rejects.toThrow(/incomplete payload/);
  });
});

// ── resolveBotToken: patched credential context → env fallback ──────────────

describe("resolveBotToken", () => {
  beforeEach(() => {
    resetWorkspaceCacheForTests();
    delete process.env.SLACK_BOT_TOKEN;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.SLACK_BOT_TOKEN;
  });

  test("resolves via the context teamId", async () => {
    const stub = installFetchStub(() =>
      Response.json({ ...WORKSPACE_PAYLOAD, teamId: "T_CTX", botToken: "xoxb-ctx" }),
    );

    expect(await resolveBotToken({ teamId: "T_CTX" })).toBe("xoxb-ctx");
    expect(stub.calls[0]?.url).toBe(
      "https://maple-api.test/internal/slack/workspaces/T_CTX",
    );
  });

  test("falls back to SLACK_BOT_TOKEN when called without context", async () => {
    const stub = installFetchStub(() => Response.json(WORKSPACE_PAYLOAD));

    process.env.SLACK_BOT_TOKEN = "xoxb-env";
    expect(await resolveBotToken()).toBe("xoxb-env");
    expect(stub.calls.length).toBe(0);
  });

  test("throws when called without context and no env fallback exists", async () => {
    installFetchStub(() => Response.json(WORKSPACE_PAYLOAD));

    await expect(resolveBotToken()).rejects.toThrow(/No current Slack team context/);
  });

  test("falls back to SLACK_BOT_TOKEN when the team is not installed", async () => {
    installFetchStub(() => new Response(null, { status: 404 }));

    process.env.SLACK_BOT_TOKEN = "xoxb-env";
    expect(await resolveBotToken({ teamId: "T_UNINSTALLED" })).toBe("xoxb-env");
  });

  test("throws when the team is unlinked and no env fallback exists", async () => {
    installFetchStub(() => new Response(null, { status: 404 }));

    await expect(resolveBotToken({ teamId: "T_UNINSTALLED" })).rejects.toThrow(
      /not linked/,
    );
  });
});
