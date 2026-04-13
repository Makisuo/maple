import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Cli } from "../Cli/Cli.ts";

export const TestCli = Layer.succeed(
  Cli,
  Cli.of({
    approvePlan: () => Effect.succeed(true),
    displayPlan: () => Effect.void,
    startApplySession: () =>
      Effect.succeed({
        done: () => Effect.void,
        emit: (event) =>
          Effect.log(
            event.kind === "status-change"
              ? `${event.status} ${event.id}(${event.type})`
              : `${event.id}: ${event.message}`,
          ),
      }),
  }),
);
