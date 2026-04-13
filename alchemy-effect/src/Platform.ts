import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Scope } from "effect/Scope";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import { SingleShotGen } from "effect/Utils";
import type { PolicyLike } from "./Binding.ts";
import {
  ExecutionContext,
  type BaseExecutionContext,
} from "./ExecutionContext.ts";
import type { HttpEffect } from "./Http.ts";
import type { InputProps } from "./Input.ts";
import type { Provider } from "./Provider.ts";
import { Resource, type ResourceLike } from "./Resource.ts";
import { Self } from "./Self.ts";
import type { Stack, StackServices } from "./Stack.ts";
import type { Stage } from "./Stage.ts";
import { effectClass } from "./Util/effect.ts";

export interface PlatformProps {
  /**
   * @internal type used to signal when this is an effect-native implementation
   * @default false
   */
  isExternal?: boolean;
}

export type Main<Services = never> = void | {
  fetch: HttpEffect<Services | PlatformServices>;
};

export type Rpc<Shape> = {
  "~alchemy-effect/rpc": Shape;
};

// services provided to the Resource
export type PlatformServices =
  | ExecutionContext
  | HttpClient
  | PolicyLike
  | Provider<any>
  | Scope
  | Stack
  | StackServices
  | Stage;

export interface Platform<
  Resource extends ResourceLike<string, PlatformProps>,
  Services,
  MainShape,
  ExecutionContext extends BaseExecutionContext,
  BaseShape = {},
> extends Effect.Effect<
  Resource & ExecutionContext,
  never,
  Services | PlatformServices
> {
  Type: Resource["Type"];
  Provider: Provider<Resource>;

  <Self, Shape>(): {
    <PropsReq = never>(
      id: string,
      props:
        | InputProps<Resource["Props"]>
        | Effect.Effect<InputProps<Resource["Props"]>, never, PropsReq>,
    ): Effect.Effect<
      Resource & Rpc<Self>,
      never,
      Self | Provider<Resource> | PropsReq
    > & {
      make<InitReq = never>(
        impl: Effect.Effect<Shape, never, InitReq>,
      ): Layer.Layer<
        Self,
        never,
        | Provider<Resource>
        | Exclude<PropsReq | InitReq, Services | PlatformServices>
      >;
      new (_: never): MakeShape<Shape, BaseShape>;
      of(shape: Shape & MainShape): MakeShape<Shape, BaseShape>;
    };
  };
  <Self>(): {
    <
      Shape extends MainShape,
      PropsReq = never,
      InitReq extends Services | PlatformServices = never,
    >(
      id: string,
      props:
        | InputProps<Resource["Props"]>
        | Effect.Effect<Resource["Props"], never, PropsReq>,
      impl: Effect.Effect<Shape, never, InitReq>,
    ): Effect.Effect<
      Resource & Rpc<Self>,
      never,
      | Provider<Resource>
      | PropsReq
      | Exclude<InitReq, Services | PlatformServices>
    > & {
      new (_: never): MakeShape<Shape, BaseShape>;
    };
    <Shape, PropsReq = never>(
      id: string,
      props:
        | InputProps<Resource["Props"]>
        | Effect.Effect<InputProps<Resource["Props"]>, never, PropsReq>,
    ): Effect.Effect<
      Resource & Rpc<Self>,
      never,
      Provider<Resource> | PropsReq
    > & {
      make<InitReq extends Services | PlatformServices = never>(
        impl: Effect.Effect<Shape, never, InitReq>,
      ): Layer.Layer<
        Self,
        never,
        | Provider<Resource>
        | Exclude<PropsReq | InitReq, Services | PlatformServices>
      >;
      new (_: never): MakeShape<Shape, BaseShape>;
    } & (<InitReq extends Services | PlatformServices = never>(
        impl: Effect.Effect<Shape, never, InitReq>,
      ) => Effect.Effect<
        Resource & Rpc<Self>,
        never,
        | Provider<Resource>
        | PropsReq
        | Exclude<InitReq, Services | PlatformServices>
      >);
  };
  // <PropsReq = never, InitReq extends Services | PlatformServices = never>(
  //   id: string,
  //   props:
  //     | InputProps<Resource["Props"]>
  //     | Effect.Effect<InputProps<Resource["Props"]>, never, PropsReq>,
  // ): Effect.Effect<
  //   Resource,
  //   never,
  //   | Provider<Resource>
  //   | PropsReq
  //   | Exclude<InitReq, Services | PlatformServices>
  // >;
  <
    Shape extends MainShape,
    PropsReq = never,
    InitReq extends Services | PlatformServices = never,
  >(
    id: string,
    props:
      | InputProps<Resource["Props"]>
      | Effect.Effect<InputProps<Resource["Props"]>, never, PropsReq>,
    impl: Effect.Effect<Shape, never, InitReq>,
  ): Effect.Effect<
    Resource & Rpc<Shape>,
    never,
    | Provider<Resource>
    | PropsReq
    | Exclude<InitReq, Services | PlatformServices>
  >;
}

type MakeShape<Shape, BaseShape> = Shape extends never | undefined | void
  ? BaseShape
  : Shape & BaseShape;

export const Platform = <
  R extends ResourceLike<
    string,
    | {
        env?: Record<string, any>;
        exports?: string[];
      }
    | undefined
  >,
>(
  type: R["Type"],
  hooks: {
    createExecutionContext: (id: string) => BaseExecutionContext;
    onCreate?: (resource: R, props: any) => Effect.Effect<void>;
  },
  methods?: { [key: string]: any },
): any => {
  type Props = any;
  type Impl = Effect.Effect<any>;

  const resource = Resource(type);
  const PlatformContext = ExecutionContext(type);

  const constructor = (
    id?: string,
    props?: any,
    impl?: Impl,
    isTag = false,
  ): any => {
    if (!id) {
      // impl was not provided inline, this is a tagged instance
      // e.g.
      // export class Sandbox extends Cloudflare.Container<Sandbox>()(..) {}
      //
      // export const SandboxLive = Sandbox.make(..)
      return (id: string, props?: any, impl?: Impl) =>
        constructor(id, props, impl, true);
    } else if (!impl) {
      const cls = makeClass(id, props);
      const asEffect = () =>
        (!isTag
          ? // this is a non-tagged resource yielded without providing an implementation
            // e.g.
            // yield* Cloudflare.Worker("id", { main: "./src/worker.ts" })
            //
            // This is where we bridge to non-effect, e.g. bundling an ordinary worker
            // export default {
            //   fetch: (request: Request) => {
            //     return new Response("Hello, world!");
            //   }
            // }
            resource(id, {
              ...props,
              isExternal: true,
            })
          : Effect.flatMap(
              // this is a tagged resource
              Effect.serviceOption(cls.Self),
              Option.match({
                // we are likely running at runtime, so we create
                onNone: () => resource(id, props),
                onSome: Effect.succeed,
              }),
            )
        ).pipe(
          Effect.tap(
            (resource) => hooks.onCreate?.(resource as R, props) ?? Effect.void,
          ),
        );
      return Object.assign(
        function (impl: Impl) {
          return cls.asEffect().pipe(Effect.provide(cls.make(impl)));
        },
        // we splice in the Effect so this can be yielded to indicate a non-Effect native instance
        // e.g. here, we yield it - in this case we don't want to provide an implementation
        // const worker = yield* Cloudflare.Worker("id", {
        //  main: "./src/worker.ts"
        // });
        cls,
        {
          asEffect,
          // @ts-expect-error
          pipe: (...args: any[]) => asEffect().pipe(...args),
          [Symbol.iterator]: () => new SingleShotGen({ asEffect }),
        },
      );
    } else {
      // impl was provided inline, this is a non-tagged eager instance
      // e.g.
      // export default Cloudflare.Worker("id", { main: "./src/worker.ts" }, Effect.gen(function* () { .. })
      const cls = makeClass(id, props);
      return cls.asEffect().pipe(Effect.provide(cls.make(impl)), effectClass);
    }
  };

  const makeClass = (id: string, props: Props) => {
    return class Platform {
      static readonly Self = Self(`${type}<${id}>`);
      static readonly Platform = Context.Service<Platform, Platform>(
        `Platform<${type}<${id}>>`,
      );
      static [Symbol.iterator](): Iterator<
        Effect.Yieldable<any, void, never, Self>,
        Resource,
        void
      > {
        return new SingleShotGen(this) as any;
      }
      static asEffect() {
        return this.Self.asEffect();
      }
      static pipe(...args: any[]) {
        // @ts-expect-error
        return pipe(this.asEffect(), ...args);
      }
      static of = (shape: any) => shape;
      static make = (impl: Impl) => {
        // build the Layer once for the root Self
        const SelfLayer = Layer.effect(
          Self,
          Effect.flatMap(
            Effect.all([
              Effect.isEffect(props) ? props : Effect.succeed(props ?? {}),
              Effect.sync(() => hooks.createExecutionContext(id)),
              Effect.context<never>(),
            ]),
            Effect.fnUntraced(function* ([
              props,
              executionContext,
              outerServices,
            ]) {
              const instance = Object.assign(
                yield* resource(id, props as any).pipe(
                  Effect.flatMap(
                    (resource) =>
                      hooks
                        .onCreate?.(resource, props)
                        .pipe(Effect.map(() => resource)) ??
                      Effect.succeed(resource),
                  ),
                ),
                executionContext,
              );

              yield* impl.pipe(
                Effect.flatMap((impl) =>
                  impl
                    ? (executionContext.serve?.(impl.fetch) ??
                      Effect.die("No serve handler"))
                    : Effect.void,
                ),
                Effect.provide(
                  Layer.provideMerge(
                    Layer.mergeAll(
                      Layer.succeed(Platform.Platform, executionContext),
                      Layer.succeed(PlatformContext, executionContext),
                      Layer.succeed(ExecutionContext, executionContext),
                      Layer.succeed(resource.Self, instance),
                      Layer.succeed(Platform.Self, instance),
                      Layer.succeed(Self, instance),
                    ),
                    Layer.succeedContext(outerServices),
                  ),
                ),
              );

              instance.Props = {
                ...props,
                env: {
                  ...props?.env,
                  ...executionContext.env,
                },
                exports: executionContext.exports
                  ? yield* executionContext.exports
                  : undefined,
              };

              return Object.assign(instance, {
                ExecutionContext: executionContext,
              }) as R;
            }),
          ),
        );
        const self = Self.asEffect() as any; // TODO(sam): why do we need to cast?

        return Layer.provideMerge(
          Layer.mergeAll(
            // sets the Context for all self-hierarchies
            // Self
            // Self<Cloudflare.Worker>
            // Self<Cloudflare.Worker<Api>>
            Layer.effect(Self<R>(type), self),
            Layer.effect(Self<R>(`${type}<${id}>`), self),
          ),
          // provide here so we build once and just mirror
          SelfLayer,
        );
      };
    };
  };

  const instance = Object.assign(constructor, resource, {
    Platform: Platform,
    asEffect: () => resource.Self.asEffect(),
    ...methods,
  }) as any;
  return instance;
};
