// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as SignInRoute from "./sign-in";

describe("SelfHostedSignInPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("stores session token on successful root-password login", async () => {
    vi.spyOn(window, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "session-token",
          orgId: "default",
          userId: "root",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.spyOn(SignInRoute, "redirectToDashboard").mockImplementation(() => {});

    render(<SignInRoute.SelfHostedSignInPage />);

    fireEvent.change(screen.getByPlaceholderText("Root password"), {
      target: { value: "root-password" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form")!);

    await waitFor(() => {
      expect(window.sessionStorage.getItem("maple.self_hosted.token")).toBe("session-token");
    });
  });

  it("shows an error and does not store token on failed login", async () => {
    vi.spyOn(window, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          message: "Invalid root password",
        }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    render(<SignInRoute.SelfHostedSignInPage />);

    fireEvent.change(screen.getByPlaceholderText("Root password"), {
      target: { value: "wrong-password" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form")!);

    await waitFor(() => {
      expect(screen.getByText("Invalid root password")).toBeTruthy();
    });
    expect(window.sessionStorage.getItem("maple.self_hosted.token")).toBeNull();
  });
});
