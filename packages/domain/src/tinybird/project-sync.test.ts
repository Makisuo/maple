import { afterEach, describe, expect, it, mock } from "bun:test"
import { datasources, pipes, projectRevision } from "../generated/tinybird-project-manifest"
import {
  cleanupOwnedTinybirdDeployment,
  fetchInstanceHealth,
  getDeploymentStatus,
  getCurrentTinybirdProjectRevision,
  resumeTinybirdDeployment,
  startTinybirdDeployment,
  TinybirdSyncRejectedError,
  TinybirdSyncUnavailableError,
} from "./project-sync"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("Tinybird project sync", () => {
  it("returns the bundled project revision", async () => {
    expect(await getCurrentTinybirdProjectRevision()).toBe(projectRevision)
  })

  it("uploads the bundled Tinybird resources without building from disk at runtime", async () => {
    let requestBody: FormData | null = null
    let authorizationHeader = ""

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
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

        return new Response(
          JSON.stringify({
            result: "no_changes",
            deployment: { id: "dep-1", status: "live" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        )
      }

      throw new Error(`Unexpected request: ${method} ${url}`)
    }) as unknown as typeof fetch

    const result = await startTinybirdDeployment({
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
    expect(requestBody).toBeInstanceOf(FormData)
    if (requestBody == null) {
      throw new Error("Expected Tinybird sync to upload a multipart body")
    }

    const uploadedBody = requestBody as FormData
    const uploadedFiles = uploadedBody.getAll("data_project://") as File[]
    const uploadedNames = uploadedFiles.map((file) => file.name).sort()
    const expectedNames = [
      ...datasources.map((resource) => `${resource.name}.datasource`),
      ...pipes.map((resource) => `${resource.name}.pipe`),
    ].sort()

    expect(uploadedNames).toEqual(expectedNames)
  })

  it("classifies Tinybird deploy rejections as user-fixable upstream errors", async () => {
    globalThis.fetch = mock(async () =>
      new Response("bad credentials", {
        status: 401,
        headers: { "content-type": "text/plain" },
      })) as unknown as typeof fetch

    let error: unknown
    try {
      await startTinybirdDeployment({
        baseUrl: "https://customer.tinybird.co",
        token: "bad-token",
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(TinybirdSyncRejectedError)
  })

  it("extracts structured Tinybird feedback instead of showing the raw deploy response body", async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
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
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      )) as unknown as typeof fetch

    await expect(
      startTinybirdDeployment({
        baseUrl: "https://customer.tinybird.co",
        token: "token",
      }),
    ).rejects.toMatchObject({
      name: "TinybirdSyncRejectedError",
      message:
        "Tinybird already has a deployment in progress. Wait for it to finish, then retry. If needed, promote or discard the existing deployment in Tinybird first.",
    })
  })

  it("treats invalid Tinybird JSON as an upstream availability problem", async () => {
    globalThis.fetch = mock(async () =>
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch

    let error: unknown
    try {
      await startTinybirdDeployment({
        baseUrl: "https://customer.tinybird.co",
        token: "token",
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(TinybirdSyncUnavailableError)
  })

  it("does not delete active or in-progress deployments during owned cleanup", async () => {
    const requests: string[] = []

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const isRequest = input instanceof Request
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? (isRequest ? input.method : "GET")
      requests.push(`${method} ${url}`)

      if (method === "GET") {
        return new Response(
          JSON.stringify({
            deployment: { status: "deploying" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        )
      }

      return new Response("", { status: 204 })
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

  it("treats data_ready as ready to promote, not as live", async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          deployment: { status: "data_ready" },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )) as unknown as typeof fetch

    const result = await getDeploymentStatus({
      baseUrl: "https://customer.tinybird.co",
      token: "token",
      deploymentId: "dep-1",
    })

    expect(result).toEqual({
      deploymentId: "dep-1",
      status: "data_ready",
      isTerminal: false,
      errorMessage: null,
    })
  })

  it("treats live as the successful terminal deployment state", async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          deployment: { status: "live" },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )) as unknown as typeof fetch

    const result = await getDeploymentStatus({
      baseUrl: "https://customer.tinybird.co",
      token: "token",
      deploymentId: "dep-1",
    })

    expect(result).toEqual({
      deploymentId: "dep-1",
      status: "live",
      isTerminal: true,
      errorMessage: null,
    })
  })

  it("fails resumeDeployment when Tinybird reaches a terminal error state", async () => {
    let pollCount = 0

    globalThis.fetch = mock(async () => {
      pollCount += 1
      return new Response(
        JSON.stringify({
          deployment: {
            status: "failed",
            errors: ["broken pipe"],
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    }) as unknown as typeof fetch

    await expect(
      resumeTinybirdDeployment({
        baseUrl: "https://customer.tinybird.co",
        token: "token",
        deploymentId: "dep-1",
      }),
    ).rejects.toBeInstanceOf(TinybirdSyncRejectedError)

    expect(pollCount).toBeGreaterThan(0)
  })

  it("treats non-JSON health probe responses as missing metrics instead of failing", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
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

      if (parsedUrl.pathname === "/v0/sql" && method === "GET" && query.includes("datasources_storage")) {
        return new Response("datasource probe exploded", {
          status: 502,
          headers: { "content-type": "text/plain" },
        })
      }

      if (parsedUrl.pathname === "/v0/sql" && method === "GET" && query.includes("endpoint_errors")) {
        return new Response(JSON.stringify({ data: [{ cnt: 4 }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }

      if (parsedUrl.pathname === "/v0/sql" && method === "GET" && query.includes("pipe_stats_rt")) {
        return new Response(JSON.stringify({ data: [{ avg_ms: "0.0974" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
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
});
