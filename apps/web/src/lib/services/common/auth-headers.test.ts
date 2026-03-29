import { beforeEach, describe, expect, it } from "vitest";
import {
  clearMapleAuthHeaders,
  getMapleAuthHeaders,
  setMapleAuthHeaders,
  setMapleAuthHeadersProvider,
} from "./auth-headers";

describe("auth-headers", () => {
  beforeEach(() => {
    setMapleAuthHeadersProvider(undefined);
    clearMapleAuthHeaders();
  });

  it("injects dynamic async auth headers", async () => {
    setMapleAuthHeadersProvider(async () => ({
      authorization: "Bearer clerk-session-token",
    }));

    await expect(getMapleAuthHeaders()).resolves.toEqual({
      authorization: "Bearer clerk-session-token",
    });
  });

  it("keeps static header override compatibility", async () => {
    setMapleAuthHeaders({
      "x-maple-org-id": "org_local",
      "x-maple-user-id": "user_local",
    });

    await expect(getMapleAuthHeaders()).resolves.toEqual({
      "x-maple-org-id": "org_local",
      "x-maple-user-id": "user_local",
    });
  });

  it("clears static headers when requested", async () => {
    setMapleAuthHeaders({
      authorization: "Bearer stale-token",
    });

    clearMapleAuthHeaders();

    await expect(getMapleAuthHeaders()).resolves.toEqual({});
  });
});
