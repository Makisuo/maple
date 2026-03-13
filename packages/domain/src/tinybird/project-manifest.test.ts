import { describe, expect, it } from "bun:test"
import {
  buildTinybirdProjectManifest,
  createTinybirdProjectRevision,
  renderTinybirdProjectManifestModule,
} from "./project-manifest"

describe("Tinybird project manifest", () => {
  it("builds datasource and pipe resources from the current repo definitions", async () => {
    const manifest = await buildTinybirdProjectManifest()

    expect(manifest.datasources.some((resource) => resource.name === "logs")).toBe(true)
    expect(manifest.pipes.some((resource) => resource.name === "list_traces")).toBe(true)
    expect(manifest.projectRevision).toBe(
      createTinybirdProjectRevision(manifest.datasources, manifest.pipes),
    )
  })

  it("keeps a stable project revision for unchanged inputs", async () => {
    const first = await buildTinybirdProjectManifest()
    const second = await buildTinybirdProjectManifest()

    expect(second.projectRevision).toBe(first.projectRevision)
    expect(renderTinybirdProjectManifestModule(first)).toContain(first.projectRevision)
  })
})
