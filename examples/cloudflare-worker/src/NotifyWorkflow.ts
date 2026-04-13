import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";
import Room from "./Room.ts";

export default class NotifyWorkflow extends Cloudflare.Workflow<NotifyWorkflow>()(
  "Notifier",
  Effect.gen(function* () {
    const rooms = yield* Room;

    return Effect.gen(function* () {
      const event = yield* Cloudflare.WorkflowEvent;
      const { roomId, message } = event.payload as {
        roomId: string;
        message: string;
      };

      const processed = yield* Cloudflare.task(
        "process",
        Effect.succeed({ text: `Processed: ${message}`, ts: Date.now() }),
      );

      const room = rooms.getByName(roomId);
      yield* Cloudflare.task(
        "broadcast",
        room.broadcast(`[workflow] ${processed.text}`),
      );

      yield* Cloudflare.sleep("cooldown", "2 seconds");

      yield* Cloudflare.task(
        "finalize",
        room.broadcast(`[workflow] complete for ${roomId}`),
      );

      return processed;
    });
  }),
) {}
