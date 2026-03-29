// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSelfHostedSessionToken,
  getSelfHostedSessionToken,
  resolveSelfHostedRouterAuth,
  setSelfHostedSessionToken,
} from "./self-hosted-auth";

describe("self-hosted-auth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it("returns unauthenticated state when no token exists", async () => {
    const state = await resolveSelfHostedRouterAuth("http://localhost:3472");

    expect(state).toEqual({
      isAuthenticated: false,
      orgId: null,
    });
  });

  it("clears token and returns unauthenticated state for invalid token", async () => {
    setSelfHostedSessionToken("invalid-token");
    vi.spyOn(window, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "Invalid session" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const state = await resolveSelfHostedRouterAuth("http://localhost:3472");

    expect(state).toEqual({
      isAuthenticated: false,
      orgId: null,
    });
    expect(getSelfHostedSessionToken()).toBeNull();
  });

  it("returns authenticated state for valid token", async () => {
    setSelfHostedSessionToken("valid-token");
    vi.spyOn(window, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          orgId: "default",
          userId: "root",
          roles: ["root"],
          authMode: "self_hosted",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const state = await resolveSelfHostedRouterAuth("http://localhost:3472");

    expect(state).toEqual({
      isAuthenticated: true,
      orgId: "default",
    });
    expect(getSelfHostedSessionToken()).toBe("valid-token");
  });

  it("clears token from storage when requested", () => {
    setSelfHostedSessionToken("to-clear");
    clearSelfHostedSessionToken();

    expect(getSelfHostedSessionToken()).toBeNull();
  });
});
