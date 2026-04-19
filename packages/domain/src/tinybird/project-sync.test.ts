import { afterEach, describe, expect, it, vi } from "vitest"
import { datasources, pipes, projectRevision } from "../generated/tinybird-project-manifest"
import {
  cleanupOwnedTinybirdDeployment,
  cleanupStaleTinybirdDeployments,
  fetchInstanceHealth,
  getCurrentTinybirdProjectRevision,
  getTinybirdDeploymentStatus,
  pollTinybirdDeploymentStep,
  setTinybirdDeploymentLiveStep,
  startTinybirdDeploymentStep,
  TinybirdDeploymentNotReadyError,
  TinybirdSyncRejectedError,
  TinybirdSyncUnavailableError,
} from "./project-sync"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

describe("Tinybird project sync", () => {
  it("returns the bundled project revision", async () => {
    expect(await getCurrentTinybirdProjectRevision()).toBe(projectRevision)
  })

  describe("startTinybirdDeploymentStep", () => {
    it("uploads the bundled Tinybird resources without building from disk at runtime", async () => {
      let requestBody: FormData | null = null
      let authorizationHeader = ""

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const isRequest = input instanceof Request
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? (isRequest ? input.method : "GET")
        const headers = init?.headers instanceof Headers
          ? init.headers
          : isRequest
            ? input.headers
            : new Headers(init?.headers as HeadersInit | undefined)
        authorizationHeader = headers.get("Authorization") ?? ""

        if (url.includes("/v1/deploy") && method === "POST") {
          requestBody = (init?.body ?? (isRequest ? input.body : null)) as FormData
          return jsonResponse({
            result: "no_changes",
            deployment: { id: "dep-1", status: "live" },
          })
        }

        throw new Error(`Unexpected request: ${method} ${url}`)
      }) as unknown as typeof fetch

      const result = await startTinybirdDeploymentStep({
        baseUrl: "https://customer.tinybird.co/",
        token: "customer-token",
      })

      expect(result).toEqual({
        projectRevision,
        result: "no_changes",
        deploymentId: "dep-1",
        deploymentStatus: "live",
        errorMessage: null,
      })
      expect(authorizationHeader).toBe("Bearer customer-token")
      if (requestBody == null) throw new Error("Expected multipart body")

      const uploadedFiles = (requestBody as FormData).getAll("data_project://") as File[]
      const uploadedNames = uploadedFiles.map((file) => file.name).sort()
      const expectedNames = [
        ...datasources.map((resource) => `${resource.name}.datasource`),
        ...pipes.map((resource) => `${resource.name}.pipe`),
      ].sort()
      expect(uploadedNames).toEqual(expectedNames)
    })

    it("returns a successful-in-progress deployment when Tinybird accepts the request", async () => {
      globalThis.fetch = vi.fn(async () =>
        jsonResponse({
          result: "success",
          deployment: { id: "dep-2", status: "deploying" },
        })) as unknown as typeof fetch

      const result = await startTinybirdDeploymentStep({
        baseUrl: "https://customer.tinybird.co",
        token: "token",
      })

      expect(result.result).toBe("success")
      expect(result.deploymentId).toBe("dep-2")
      expect(result.deploymentStatus).toBe("deploying")
    })

    it("classifies Tinybird deploy rejections as user-fixable upstream errors", async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response("bad credentials", { status: 401 })) as unknown as typeof fetch

      await expect(
        startTinybirdDeploymentStep({
          baseUrl: "https://customer.tinybird.co",
          token: "bad-token",
        }),
      ).rejects.toBeInstanceOf(TinybirdSyncRejectedError)
    })

    it("extracts structured Tinybird feedback instead of showing the raw deploy response body", async () => {
      globalThis.fetch = vi.fn(async () =>
        jsonResponse({
          result: "failed",
          deployment: {
            id: "59",
            status: "calculating",
            feedback: [
              {
                resource: null,
                level: "ERROR",
                message:
                  "There's already a deployment in progress.\n\nYou can check the status of your deployments with `tb deployment ls`.",
              },
            ],
          },
        }, 400)) as unknown as typeof fetch

      await expect(
        startTinybirdDeploymentStep({
          baseUrl: "https://customer.tinybird.co",
          token: "token",
        }),
      ).rejects.toMatchObject({
        _tag: "@maple/tinybird/errors/SyncRejected",
        message:
          "Tinybird already has a deployment in progress. Wait for it to finish, then retry. If needed, promote or discard the existing deployment in Tinybird first.",
      })
    })

    it("treats invalid Tinybird JSON as an upstream availability problem", async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response("not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch

      await expect(
        startTinybirdDeploymentStep({
          baseUrl: "https://customer.tinybird.co",
          token: "token",
        }),
      ).rejects.toBeInstanceOf(TinybirdSyncUnavailableError)
    })
  })

  describe("pollTinybirdDeploymentStep", () => {
    it("resolves when Tinybird reports data_ready", async () => {
      globalThis.fetch = vi.fn(async () =>
        jsonResponse({ deployment: { status: "data_ready" } })) as unknown as typeof fetch

      const result = await pollTinybirdDeploymentStep({
        baseUrl: "https://customer.tinybird.co",
        token: "token",
        deploymentId: "dep-1",
      })

      expect(result.status).toBe("data_ready")
      expect(result.isReady).toBe(true)
      expect(result.isTerminal).toBe(false)
    })

    it("resolves when Tinybird reports live", async () => {
      globalThis.fetch = vi.fn(async () =>
        jsonResponse({ deployment: { status: "live" } })) as unknown as typeof fetch

      const result = await pollTinybirdDeploymentStep({
        baseUrl: "https://customer.tinybird.co",
        token: "token",
        deploymentId: "dep-1",
      })

      expect(result.status).toBe("live")
      expect(result.isReady).toBe(true)
      expect(result.isTerminal).toBe(true)
    })

    it("throws TinybirdDeploymentNotReadyError for non-terminal non-ready statuses so workflow steps retry", async () => {
      globalThis.fetch = vi.fn(async () =>
        jsonResponse({ deployment: { status: "deploying" } })) as unknown as typeof fetch

      await expect(
        pollTinybirdDeploymentStep({
          baseUrl: "https://customer.tinybird.co",
          token: "token",
          deploymentId: "dep-1",
        }),
      ).rejects.toBeInstanceOf(TinybirdDeploymentNotReadyError)
    })

    it("rejects with a TinybirdSyncRejectedError when Tinybird reaches a terminal error state", async () => {
      globalThis.fetch = vi.fn(async () =>
        jsonResponse({
          deployment: { status: "failed", errors: ["broken pipe"] },
        })) as unknown as typeof fetch

      await expect(
        pollTinybirdDeploymentStep({
          baseUrl: "https://customer.tinybird.co",
          token: "token",
          deploymentId: "dep-1",
        }),
      ).rejects.toBeInstanceOf(TinybirdSyncRejectedError)
    })
  })

  describe("getTinybirdDeploymentStatus", () => {
    it("treats data_ready as ready to promote, not as terminal", async () => {
      globalThis.fetch = vi.fn(async () =>
        jsonResponse({ deployment: { status: "data_ready" } })) as unknown as typeof fetch

      const result = await getTinybirdDeploymentStatus({
        baseUrl: "https://customer.tinybird.co",
        token: "token",
        deploymentId: "dep-1",
      })

      expect(result.status).toBe("data_ready")
      expect(result.isReady).toBe(true)
      expect(result.isTerminal).toBe(false)
      expect(result.errorMessage).toBeNull()
    })

    it("treats live as the successful terminal deployment state", async () => {
      globalThis.fetch = vi.fn(async () =>
        jsonResponse({ deployment: { status: "live" } })) as unknown as typeof fetch

      const result = await getTinybirdDeploymentStatus({
        baseUrl: "https://customer.tinybird.co",
        token: "token",
        deploymentId: "dep-1",
      })

      expect(result.status).toBe("live")
      expect(result.isReady).toBe(true)
      expect(result.isTerminal).toBe(true)
    })
  })

  describe("setTinybirdDeploymentLiveStep", () => {
    it("POSTs to /v1/deployments/:id/set-live", async () => {
      const calls: Array<{ url: string; method: string }> = []

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? "GET"
        calls.push({ url, method })
        return new Response("", { status: 200 })
      }) as unknown as typeof fetch

      await setTinybirdDeploymentLiveStep({
        baseUrl: "https://customer.tinybird.co",
        token: "token",
        deploymentId: "dep-1",
      })

      expect(calls).toHaveLength(1)
      expect(calls[0]?.method).toBe("POST")
      expect(calls[0]?.url).toContain("/v1/deployments/dep-1/set-live")
    })
  })

  describe("cleanupStaleTinybirdDeployments", () => {
    it("deletes non-live deployments returned by the list endpoint", async () => {
      const calls: Array<{ method: string; url: string }> = []

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? "GET"
        calls.push({ method, url })

        if (method === "GET" && url.includes("/v1/deployments")) {
          return jsonResponse({
            deployments: [
              { id: "live-1", status: "live", live: true },
              { id: "stale-1", status: "deploying", live: false },
              { id: "stale-2", status: "data_ready", live: false },
            ],
          })
        }

        return new Response("", { status: 200 })
      }) as unknown as typeof fetch

      await cleanupStaleTinybirdDeployments({
        baseUrl: "https://customer.tinybird.co",
        token: "token",
      })

      const deletes = calls.filter((c) => c.method === "DELETE")
      const deleteIds = deletes.map((c) => c.url.match(/\/v1\/deployments\/([^?]+)/)?.[1]).sort()
      expect(deleteIds).toEqual(["stale-1", "stale-2"])
    })

    it("is a no-op when there are no stale deployments", async () => {
      const calls: Array<{ method: string; url: string }> = []

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? "GET"
        calls.push({ method, url })

        return jsonResponse({
          deployments: [{ id: "live-1", status: "live", live: true }],
        })
      }) as unknown as typeof fetch

      await cleanupStaleTinybirdDeployments({
        baseUrl: "https://customer.tinybird.co",
        token: "token",
      })

      expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0)
    })
  })

  describe("cleanupOwnedTinybirdDeployment", () => {
    it("does not delete active or in-progress deployments", async () => {
      const requests: string[] = []

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? "GET"
        requests.push(`${method} ${url}`)

        if (method === "GET") {
          return jsonResponse({ deployment: { status: "deploying" } })
        }

        return new Response("", { status: 200 })
      }) as unknown as typeof fetch

      await cleanupOwnedTinybirdDeployment({
        baseUrl: "https://customer.tinybird.co",
        token: "token",
        deploymentId: "dep-1",
      })

      expect(requests).toEqual([
        "GET https://customer.tinybird.co/v1/deployments/dep-1?from=ts-sdk",
      ])
    })
  })

  describe("fetchInstanceHealth", () => {
    it("treats non-JSON health probe responses as missing metrics instead of failing", async () => {
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const isRequest = input instanceof Request
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? (isRequest ? input.method : "GET")

        if (url.includes("/v1/workspace") && method === "GET") {
          return new Response("<html>not json</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          })
        }

        const parsedUrl = new URL(url)
        const query = parsedUrl.searchParams.get("q") ?? ""

        if (parsedUrl.pathname === "/v0/sql" && query.includes("datasources_storage")) {
          return new Response("datasource probe exploded", { status: 502 })
        }
        if (parsedUrl.pathname === "/v0/sql" && query.includes("endpoint_errors")) {
          return jsonResponse({ data: [{ cnt: 4 }] })
        }
        if (parsedUrl.pathname === "/v0/sql" && query.includes("pipe_stats_rt")) {
          return jsonResponse({ data: [{ avg_ms: "0.0974" }] })
        }

        throw new Error(`Unexpected request: ${method} ${url}`)
      }) as unknown as typeof fetch

      const result = await fetchInstanceHealth({
        baseUrl: "https://customer.tinybird.co",
        token: "token",
      })

      expect(result).toEqual({
        workspaceName: null,
        datasources: [],
        totalRows: 0,
        totalBytes: 0,
        recentErrorCount: 4,
        avgQueryLatencyMs: 97.4,
      })
    })
  })
})
