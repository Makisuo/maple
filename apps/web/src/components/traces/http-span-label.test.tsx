// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { HttpSpanLabel } from "./http-span-label";

afterEach(() => {
  cleanup();
});

describe("HttpSpanLabel", () => {
  it("renders method badge and route for name-only HTTP spans", () => {
    render(<HttpSpanLabel spanName="GET /checkout" />);

    expect(screen.getByText("GET")).toBeTruthy();
    expect(screen.getByText("/checkout")).toBeTruthy();
  });

  it("renders plain fallback text for non-http spans", () => {
    render(<HttpSpanLabel spanName="CheckoutService.createOrder" />);

    expect(screen.getByText("CheckoutService.createOrder")).toBeTruthy();
    expect(screen.queryByText("GET")).toBeNull();
  });

  it("prefers attributes when provided", () => {
    render(
      <HttpSpanLabel
        spanName="GET /stale-route"
        spanAttributes={{
          "http.method": "POST",
          "http.route": "/orders/:id",
        }}
      />,
    );

    expect(screen.getByText("POST")).toBeTruthy();
    expect(screen.getByText("/orders/:id")).toBeTruthy();
    expect(screen.queryByText("/stale-route")).toBeNull();
  });
});
