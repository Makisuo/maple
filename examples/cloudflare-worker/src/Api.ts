import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import Agent from "./Agent.ts";
import { Bucket } from "./Bucket.ts";
import { KV } from "./KV.ts";
import NotifyWorkflow from "./NotifyWorkflow.ts";
import Room from "./Room.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.path,
    observability: {
      enabled: true,
    },
    compatibility: {
      flags: ["nodejs_compat"],
      date: "2026-03-17",
    },
    assets: "./assets",
    build: {
      // metafile: true,
    },
  },
  Effect.gen(function* () {
    // const betterAuth = yield* BetterAuth.BetterAuth;
    const agents = yield* Agent;
    const rooms = yield* Room;
    const notifier = yield* NotifyWorkflow;
    const loader = yield* Cloudflare.DynamicWorkerLoader("Loader");
    const bucket = yield* Cloudflare.R2Bucket.bind(Bucket);
    const kv = yield* Cloudflare.KVNamespace.bind(KV);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        if (request.url.startsWith("/auth/")) {
          // return yield* betterAuth.fetch;
        } else if (request.url.startsWith("/kv/")) {
          if (request.method === "GET") {
            const key = request.url.split("/").pop()!;
            return yield* kv.get(key).pipe(
              Effect.map((value) =>
                value
                  ? HttpServerResponse.text(value)
                  : HttpServerResponse.empty({ status: 404 }),
              ),
              Effect.catch(() =>
                Effect.succeed(HttpServerResponse.empty({ status: 404 })),
              ),
            );
          } else if (request.method === "POST") {
            const key = request.url.split("/").pop()!;
            const value = yield* request.text;
            return yield* kv.put(key, value).pipe(
              Effect.map(() => HttpServerResponse.empty({ status: 200 })),
              Effect.catch(() =>
                Effect.succeed(HttpServerResponse.empty({ status: 500 })),
              ),
            );
          }
        } else if (request.url.startsWith("/object/")) {
          if (request.method === "GET") {
            return yield* bucket.get(request.url.split("/").pop()!).pipe(
              Effect.flatMap((object) =>
                object === null
                  ? Effect.succeed(
                      HttpServerResponse.text("Object not found", {
                        status: 404,
                      }),
                    )
                  : object.text().pipe(
                      Effect.map((text) =>
                        HttpServerResponse.text(text, {
                          headers: { "content-type": "application/json" },
                        }),
                      ),
                    ),
              ),
              Effect.catchTag("R2Error", (error) =>
                Effect.succeed(
                  HttpServerResponse.text(error.message, {
                    status: 500,
                    statusText: error.message,
                  }),
                ),
              ),
            );
          } else if (request.method === "POST" || request.method === "PUT") {
            // const request = yield* Cloudflare.Request
            const key = request.url.split("/").pop()!;
            return yield* bucket
              .put(key, request.stream, {
                contentLength: Number(request.headers["content-length"] ?? 0),
              })
              .pipe(
                Effect.map(() => HttpServerResponse.empty({ status: 201 })),
                Effect.catch((err) =>
                  Effect.succeed(
                    HttpServerResponse.jsonUnsafe(
                      {
                        error: err.message,
                        headers: request.headers,
                      },
                      { status: 500 },
                    ),
                  ),
                ),
              );
          } else {
            return HttpServerResponse.text("Method not allowed", {
              status: 405,
            });
          }
        } else if (request.url === "/sandbox/increment") {
          const agent = agents.getByName("sandbox-test");
          const body = yield* agent.increment().pipe(Effect.orDie);
          const room = rooms.getByName("default");
          yield* room.broadcast(`[container] ${body}`).pipe(Effect.orDie);
          return HttpServerResponse.text(body, {
            headers: { "content-type": "application/json" },
          });
        } else if (request.url.startsWith("/sandbox")) {
          const agent = agents.getByName("sandbox-test");
          const body = yield* agent.hello().pipe(Effect.orDie);
          return HttpServerResponse.text(body);
        } else if (request.url.startsWith("/workflow/start/")) {
          const roomId = request.url.split("/workflow/start/")[1];
          if (!roomId) {
            return yield* HttpServerResponse.json(
              { error: "roomId is required" },
              { status: 400 },
            );
          }
          const instance = yield* notifier.create({
            roomId,
            message: "hello from workflow",
          });
          return yield* HttpServerResponse.json({ instanceId: instance.id });
        } else if (request.url.startsWith("/workflow/status/")) {
          const instanceId = request.url.split("/workflow/status/")[1];
          if (!instanceId) {
            return yield* HttpServerResponse.json(
              { error: "instanceId is required" },
              { status: 400 },
            );
          }
          const instance = yield* notifier.get(instanceId);
          const status = yield* instance.status();
          return yield* HttpServerResponse.json(status);
        } else if (request.url.startsWith("/eval")) {
          if (request.method === "POST") {
            const code = yield* request.text;
            const worker = loader.load({
              compatibilityDate: "2026-01-28",
              mainModule: "worker.js",
              modules: {
                "worker.js": `
                  export default {
                    async fetch(request) {
                      try {
                        const result = (0, eval)(${"`${await request.text()}`"});
                        return new Response(String(result), { status: 200 });
                      } catch (e) {
                        return new Response(e.message, { status: 500 });
                      }
                    }
                  }
                `,
              },
              globalOutbound: null,
            });
            return yield* worker
              .fetch(
                HttpClientRequest.post("https://worker/").pipe(
                  HttpClientRequest.setBody(HttpBody.text(code)),
                ),
              )
              .pipe(
                Effect.map(HttpServerResponse.fromClientResponse),
                Effect.orDie,
              );
          }
        } else if (request.url.startsWith("/connect/")) {
          const agentId = request.url.split("/").pop()!;
          const agent = agents.getByName(agentId);
          const response = yield* agent.fetch(request);
          return response;
        } else if (request.url.startsWith("/room/")) {
          const upgradeHeader = request.headers.upgrade;
          const roomId = request.url.split("/").pop()!;
          if (!upgradeHeader || upgradeHeader !== "websocket") {
            return HttpServerResponse.text(
              "Worker expected Upgrade: websocket",
              { status: 426 },
            );
          } else if (request.method !== "GET") {
            return HttpServerResponse.text("Method not allowed", {
              status: 405,
            });
          }
          const room = rooms.getByName(roomId);
          const response = yield* room.fetch(request);
          return response;
        }
        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.R2BucketBindingLive,
        Cloudflare.KVNamespaceBindingLive,
      ),
    ),
  ),
) {}
