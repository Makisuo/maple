import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * Ephemeral chat room: broadcasts each text message to every connected client.
 * Uses Durable Object storage of WebSocket attachments so sessions survive hibernation.
 */
export default class Room extends Cloudflare.DurableObjectNamespace<Room>()(
  "Rooms",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;

      const sessions = new Map<string, Cloudflare.DurableWebSocket>();

      for (const socket of yield* state.getWebSockets()) {
        const attachment = socket.deserializeAttachment<{ id: string }>();
        if (attachment) {
          sessions.set(attachment.id, socket);
        }
      }

      return {
        fetch: Effect.gen(function* () {
          console.log("upgrading");
          const [response, socket] = yield* Cloudflare.upgrade();
          console.log("upgraded");
          const id = crypto.randomUUID();
          socket.serializeAttachment({ id });
          sessions.set(id, socket);
          console.log("sessions", sessions.size);
          return response;
        }),
        broadcast: (text: string) =>
          Effect.gen(function* () {
            for (const peer of sessions.values()) {
              yield* peer.send(text);
            }
          }),
        webSocketMessage: Effect.fnUntraced(function* (
          socket: Cloudflare.DurableWebSocket,
          message: string | Uint8Array,
        ) {
          const attachment = socket.deserializeAttachment<{ id: string }>();
          if (!attachment) return;
          const text =
            typeof message === "string"
              ? message
              : new TextDecoder().decode(message);
          const label = attachment.id.slice(0, 8);
          for (const peer of sessions.values()) {
            yield* peer.send(`[${label}] ${text}`);
          }
        }),
        webSocketClose: Effect.fnUntraced(function* (
          ws: Cloudflare.DurableWebSocket,
          code: number,
          reason: string,
          _wasClean: boolean,
        ) {
          const attachment = ws.deserializeAttachment<{ id: string }>();
          if (attachment) {
            sessions.delete(attachment.id);
          }
          yield* ws.close(code, reason);
        }),
      };
    });
  }),
) {}
