import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Stack } from "../Stack.ts";
import { Stage } from "../Stage.ts";
import * as State from "../State/index.ts";

export const state = (resources: Record<string, State.ResourceState> = {}) =>
  Layer.effect(
    State.State,
    Effect.gen(function* () {
      return State.InMemoryService({
        [(yield* Stack).name]: {
          [yield* Stage]: resources,
        },
      });
    }),
  );

export const defaultState = (
  resources: Record<string, State.ResourceState> = {},
  other?: {
    [stack: string]: {
      [stage: string]: {
        [resourceId: string]: State.ResourceState;
      };
    };
  },
) =>
  Layer.succeed(
    State.State,
    State.InMemoryService({
      ["test-app"]: {
        ["test-stage"]: resources,
      },
      ...other,
    }),
  );
