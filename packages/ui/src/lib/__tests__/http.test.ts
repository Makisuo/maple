import { describe, expect, it } from "vite-plus/test";

import { getHttpInfo } from "../http";

describe("getHttpInfo", () => {
  it("detects HTTP from standard attrs", () => {
    expect(
      getHttpInfo("ignored", {
        "http.method": "POST",
        "http.route": "/checkout",
        "http.status_code": "201",
      }),
    ).toEqual({
      method: "POST",
      route: "/checkout",
      statusCode: 201,
      isError: false,
    });
  });

  it("detects HTTP from semantic convention attrs", () => {
    expect(
      getHttpInfo("ignored", {
        "http.request.method": "PATCH",
        "url.path": "/users/123",
        "http.response.status_code": "503",
      }),
    ).toEqual({
      method: "PATCH",
      route: "/users/123",
      statusCode: 503,
      isError: true,
    });
  });

  it("detects HTTP from name-only overview values", () => {
    expect(getHttpInfo("GET /checkout", {})).toEqual({
      method: "GET",
      route: "/checkout",
      statusCode: null,
      isError: false,
    });
  });

  it("detects HTTP from http.server span names", () => {
    expect(getHttpInfo("http.server GET /checkout", {})).toEqual({
      method: "GET",
      route: "/checkout",
      statusCode: null,
      isError: false,
    });
  });

  it("returns null for non-http spans", () => {
    expect(getHttpInfo("CheckoutService.createOrder", {})).toBeNull();
  });

  it("prefers attrs when name and attrs disagree", () => {
    expect(
      getHttpInfo("GET /checkout", {
        "http.method": "DELETE",
        "http.route": "/orders/:id",
        "http.status_code": "404",
      }),
    ).toEqual({
      method: "DELETE",
      route: "/orders/:id",
      statusCode: 404,
      isError: false,
    });
  });
});
