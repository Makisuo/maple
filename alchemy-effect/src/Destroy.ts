import * as Effect from "effect/Effect";
import { apply } from "./Apply.ts";
import { provideFreshArtifactStore } from "./Artifacts.ts";
import * as Plan from "./Plan.ts";
import { Stack } from "./Stack.ts";

export const destroy = () =>
  Stack.use((stack) =>
    Plan.make({
      name: stack.name,
      stage: stack.stage,
      resources: {},
      bindings: {},
      output: {},
    }).pipe(Effect.flatMap(apply), provideFreshArtifactStore),
  );
