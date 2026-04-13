import { Endpoint } from "@distilled.cloud/aws";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { StageConfig } from "./StageConfig.ts";

export const of = (endpoint: string) =>
  Layer.succeed(Endpoint.Endpoint, endpoint);

export const fromStageConfig = () =>
  Layer.unwrap(
    StageConfig.asEffect().pipe(
      Effect.map((config) =>
        config.endpoint === undefined ? Layer.empty : of(config.endpoint),
      ),
    ),
  );
