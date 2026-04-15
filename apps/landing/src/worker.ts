type Env = {
  ASSETS: { fetch: (request: Request) => Promise<Response> }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const assetResponse = await env.ASSETS.fetch(request)
    if (assetResponse.status !== 404) return assetResponse

    const url = new URL(request.url)
    const notFound = await env.ASSETS.fetch(
      new Request(new URL("/404.html", url), request),
    )
    return new Response(notFound.body, {
      status: 404,
      headers: notFound.headers,
    })
  },
}
