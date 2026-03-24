import { describe, expect, it } from "vitest"

import {
  parsePortableDashboardJson,
  toPortableDashboard,
} from "./portable-dashboard"

describe("portable-dashboard", () => {
  it("exports the canonical portable dashboard payload", () => {
    const portableDashboard = toPortableDashboard({
      id: "dash_123",
      name: "Errors Overview",
      description: "Monitors key error metrics",
      tags: ["errors", "backend"],
      timeRange: { type: "relative", value: "12h" },
      widgets: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T01:00:00.000Z",
    })

    expect(portableDashboard).toEqual({
      name: "Errors Overview",
      description: "Monitors key error metrics",
      tags: ["errors", "backend"],
      timeRange: { type: "relative", value: "12h" },
      widgets: [],
    })
  })

  it("imports canonical dashboards and strips instance metadata", () => {
    const portableDashboard = parsePortableDashboardJson(
      JSON.stringify({
        id: "dash_123",
        name: "Errors Overview",
        description: "Monitors key error metrics",
        tags: ["errors", "backend"],
        timeRange: { type: "relative", value: "12h" },
        widgets: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T01:00:00.000Z",
      }),
    )

    expect(portableDashboard).toEqual({
      name: "Errors Overview",
      description: "Monitors key error metrics",
      tags: ["errors", "backend"],
      timeRange: { type: "relative", value: "12h" },
      widgets: [],
    })
  })

  it("rejects non-canonical dashboard files", () => {
    expect(() =>
      parsePortableDashboardJson(
        JSON.stringify({
          widgets: [],
          timeRange: { type: "relative", value: "12h" },
        }),
      ),
    ).toThrow()
  })
})
