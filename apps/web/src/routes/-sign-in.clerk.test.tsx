// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("SignInPage (clerk mode)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("renders Clerk sign-in when Clerk auth mode is enabled", async () => {
    vi.doMock("@/lib/services/common/auth-mode", () => ({
      isClerkAuthEnabled: true,
    }));
    vi.doMock("@clerk/clerk-react", () => ({
      SignIn: () => <div>Clerk Sign In</div>,
    }));

    const module = await import("./sign-in");

    render(<module.SignInPage />);

    expect(screen.getByText("Clerk Sign In")).toBeTruthy();
  });
});
