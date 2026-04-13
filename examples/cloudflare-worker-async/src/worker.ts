import type { WorkerEnv } from "../alchemy.run.ts";

export default {
  async fetch(request: Request, env: WorkerEnv) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET") {
      return new Response((await env.Bucket.get(path))?.body ?? null);
    } else if (request.method === "PUT") {
      const object = (await env.Bucket.put(path, request.body))!;
      return new Response(
        JSON.stringify({
          key: object.key,
          size: object.size,
        }),
        { status: 201 },
      );
    }
    return new Response("Not Found", { status: 404 });
  },
};
