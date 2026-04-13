import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Provider from "./Provider.ts";
import { Resource } from "./Resource.ts";

export interface RandomProps {
  /**
   * Number of random bytes to generate before hex encoding.
   * @default 32
   */
  bytes?: number;
}

export type Random = Resource<
  "Alchemy.Random",
  RandomProps,
  {
    text: Redacted.Redacted<string>;
  }
>;

export const makeRandom = (id: string, props?: RandomProps) =>
  Random(id, props).pipe(Effect.flatMap((rand) => rand.text.asEffect()));

/**
 * A deterministic-in-state random secret generator.
 *
 * The value is generated once on create and then persisted in state so
 * subsequent deploys keep the same secret unless the resource is replaced.
 */
export const Random = Resource<Random>("Alchemy.Random");

export const RandomProvider = () =>
  Provider.succeed(Random, {
    create: Effect.fn(function* ({ news = {}, output }) {
      if (output?.text) {
        return output;
      }

      const byteLength = news.bytes ?? 32;
      const text = yield* Effect.sync(() => {
        const bytes = new Uint8Array(byteLength);
        crypto.getRandomValues(bytes);
        return Redacted.make(
          Array.from(bytes)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(""),
        );
      });

      return { text };
    }),
    update: Effect.fn(function* ({ output }) {
      return output;
    }),
    delete: Effect.fn(function* () {
      return undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      return output;
    }),
  });
