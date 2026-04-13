interface Env {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const accept = request.headers.get("Accept") ?? "";

    if (wantsMarkdown(accept)) {
      const url = new URL(request.url);
      const mdUrl = new URL(toMarkdownPath(url.pathname), request.url);
      const mdResponse = await env.ASSETS.fetch(new Request(mdUrl));

      if (mdResponse.ok) {
        return new Response(mdResponse.body, {
          status: 200,
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            Vary: "Accept",
          },
        });
      }
    }

    const response = await env.ASSETS.fetch(request);
    const varied = new Response(response.body, response);
    varied.headers.set("Vary", "Accept");
    return varied;
  },
};

function wantsMarkdown(accept: string): boolean {
  return (
    (accept.includes("text/markdown") || accept.includes("text/plain")) &&
    !accept.includes("text/html")
  );
}

function toMarkdownPath(pathname: string): string {
  if (pathname.endsWith("/")) return pathname + "index.md";
  if (!pathname.includes(".")) return pathname + "/index.md";
  return pathname;
}
