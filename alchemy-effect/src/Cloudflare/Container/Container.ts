import type * as cf from "@cloudflare/workers-types";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServer, type HttpEffect } from "../../Http.ts";
import * as Output from "../../Output.ts";
import { Platform } from "../../Platform.ts";
import * as Server from "../../Server/index.ts";
import type { Fetcher } from "../Fetcher.ts";
import type {
  ContainerApplication,
  ContainerApplicationProps,
  ContainerServices,
  ContainerShape,
} from "./ContainerApplication.ts";
import { bindContainer } from "./ContainerBinding.ts";

export const ContainerTypeId = "Cloudflare.Container";
export type ContainerTypeId = typeof ContainerTypeId;

export const isContainer = <T>(value: T): value is T & Container =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  value.Type === ContainerTypeId;

export class ContainerError extends Data.TaggedError("ContainerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ContainerStartupOptions extends cf.ContainerStartupOptions {}

export interface ContainerProps extends ContainerApplicationProps {
  main: string;
}

export type Container = {
  get running(): Effect.Effect<boolean>;
  start(options?: ContainerStartupOptions): Effect.Effect<void>;
  monitor(): Effect.Effect<void, ContainerError>;
  destroy(error?: any): Effect.Effect<void>;
  signal(signo: number): Effect.Effect<void>;
  getTcpPort(port: number): Effect.Effect<Fetcher>;
  setInactivityTimeout(durationMs: number | bigint): Effect.Effect<void>;
  interceptOutboundHttp(addr: string, binding: Fetcher): Effect.Effect<void>;
  interceptAllOutboundHttp(binding: Fetcher): Effect.Effect<void>;
};

export const Container: Platform<
  ContainerApplication,
  ContainerServices,
  ContainerShape,
  Server.ProcessContext,
  Container
> & {
  bind: typeof bindContainer;
} = Platform(
  "Cloudflare.Container",
  {
    createExecutionContext: (id: string): Server.ProcessContext => {
      const runners: Effect.Effect<void, never, any>[] = [];
      const env: Record<string, any> = {};

      const serve = <Req = never>(handler: HttpEffect<Req>) =>
        Effect.sync(() => {
          runners.push(
            Effect.gen(function* () {
              const httpServer = yield* Effect.serviceOption(HttpServer).pipe(
                Effect.map(Option.getOrUndefined),
              );
              if (httpServer) {
                yield* httpServer.serve(handler);
                yield* Effect.never;
              } else {
                // this should only happen at plantime, validate?
              }
            }).pipe(Effect.orDie),
          );
        });

      return {
        Type: ContainerTypeId,
        LogicalId: id,
        id,
        env,
        set: (bindingId: string, output: Output.Output) =>
          Effect.sync(() => {
            const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_");
            env[key] = output.pipe(
              Output.map((value) => JSON.stringify(value)),
            );
            return key;
          }),
        get: <T>(key: string) =>
          Config.string(key)
            .asEffect()
            .pipe(
              Effect.flatMap((value) =>
                Effect.try({
                  try: () => JSON.parse(value) as T,
                  catch: (error) => error as Error,
                }),
              ),
              Effect.catch((cause) =>
                Effect.die(
                  new Error(`Failed to get environment variable: ${key}`, {
                    cause,
                  }),
                ),
              ),
            ),
        run: ((effect: Effect.Effect<void, never, any>) =>
          Effect.sync(() => {
            runners.push(effect);
          })) as unknown as Server.ProcessContext["run"],
        serve,
        exports: Effect.sync(() => ({
          default: Effect.all(
            runners.map((eff) =>
              Effect.forever(
                eff.pipe(
                  // Log and ignore errors (daemon mode, it should just re-run)
                  Effect.tapError((err) => Effect.logError(err)),
                  Effect.ignore,
                  // TODO(sam): ignore cause? for now, let that actually kill the server
                  // Effect.ignoreCause
                ),
              ),
            ),
            {
              concurrency: "unbounded",
            },
          ),
        })),
      } as Server.ProcessContext;
    },
  },
  {
    bind: bindContainer,
  },
);
