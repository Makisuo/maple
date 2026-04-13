import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";
import type { Artifacts } from "./Artifacts.ts";
import type { ScopedPlanStatusSession } from "./Cli/index.ts";
import type { Diff } from "./Diff.ts";
import type { Input } from "./Input.ts";
import type { InstanceId } from "./InstanceId.ts";
import type { Platform } from "./Platform.ts";
import type {
  ResourceBinding,
  ResourceClass,
  ResourceLike,
} from "./Resource.ts";

export interface Provider<R extends ResourceLike = ResourceLike> {
  asEffect: () => Effect.Effect<ProviderService<R>, never, Provider<R>>;
  [Symbol.iterator]: () => Effect.EffectIterator<Provider<R>>;
  of: <
    ReadReq = never,
    DiffReq = never,
    PrecreateReq = never,
    CreateReq = never,
    UpdateReq = never,
    DeleteReq = never,
    TailReq = never,
    LogsReq = never,
  >(
    service: ProviderService<
      R,
      ReadReq,
      DiffReq,
      PrecreateReq,
      CreateReq,
      UpdateReq,
      DeleteReq,
      TailReq,
      LogsReq
    >,
  ) => ProviderService<
    R,
    ReadReq,
    DiffReq,
    PrecreateReq,
    CreateReq,
    UpdateReq,
    DeleteReq,
    TailReq,
    LogsReq
  >;
}

type LifecycleServices = InstanceId | Artifacts;

export const Provider = <R extends ResourceLike>(
  type: R["Type"],
): Provider<R> =>
  Context.Service<Provider<R>, ProviderService<R>>()(type) as any;

type BindingData<Res extends ResourceLike> = [Res] extends [
  { Binding: infer B },
]
  ? ResourceBinding<B>[]
  : any[];

type Props<Res extends ResourceLike> = keyof Res["Props"] extends never
  ? Res["Props"] | undefined
  : Res["Props"];

export interface LogLine {
  timestamp: Date;
  message: string;
}

export interface LogsInput {
  since?: Date;
  limit?: number;
}

export interface ProviderService<
  Res extends ResourceLike = ResourceLike,
  ReadReq = never,
  DiffReq = never,
  PrecreateReq = never,
  CreateReq = never,
  UpdateReq = never,
  DeleteReq = never,
  TailReq = never,
  LogsReq = never,
> {
  /**
   * The version of the provider.
   *
   * @default 0
   */
  version?: number;
  /**
   * Returns a stream of log lines for a deployed resource.
   * Used by `alchemy tail` to stream real-time logs.
   */
  tail?(input: {
    id: string;
    instanceId: string;
    props: Props<Res>;
    output: Res["Attributes"];
  }): Stream.Stream<LogLine, any, TailReq>;
  /**
   * Queries historical logs for a deployed resource.
   * Used by `alchemy logs` to fetch past log entries.
   */
  logs?(input: {
    id: string;
    instanceId: string;
    props: Props<Res>;
    output: Res["Attributes"];
    options: LogsInput;
  }): Effect.Effect<LogLine[], any, LogsReq>;
  // watch();
  // replace(): Effect.Effect<void, never, never>;
  // different interface that is persistent, watching, reloads
  // run?() {}
  // branch?() {}
  read?(input: {
    id: string;
    instanceId: string;
    olds: Props<Res>;
    // what is the ARN?
    output: Res["Attributes"] | undefined; // current state -> synced state
  }): Effect.Effect<Res["Attributes"] | undefined, any, ReadReq>;
  /**
   * Properties that are always stable across any update.
   */
  stables?: Extract<keyof Res["Attributes"], string>[];
  diff?(input: {
    id: string;
    instanceId: string;
    olds: Props<Res>;
    // Note: we do not resolve (Res["Props"]) here because diff runs during plan
    // -> we need a way for the diff handlers to work with Outputs
    news: Input<Props<Res>>;
    oldBindings: BindingData<Res>;
    newBindings: Input<BindingData<Res>>;
    output: Res["Attributes"] | undefined;
  }): Effect.Effect<Diff | void, any, DiffReq>;
  // dev?:() => Effect.Effect<void, any, DevReq>;
  precreate?(input: {
    id: string;
    news: Props<Res>;
    instanceId: string;
    session: ScopedPlanStatusSession;
    bindings: BindingData<Res>;
  }): Effect.Effect<Res["Attributes"], any, PrecreateReq>;
  create(input: {
    id: string;
    instanceId: string;
    news: Props<Res>;
    session: ScopedPlanStatusSession;
    bindings: BindingData<Res>;
    output?: Res["Attributes"];
  }): Effect.Effect<Res["Attributes"], any, CreateReq>;
  update(input: {
    id: string;
    instanceId: string;
    news: Props<Res>;
    olds: Props<Res>;
    output: Res["Attributes"];
    session: ScopedPlanStatusSession;
    bindings: BindingData<Res>;
  }): Effect.Effect<Res["Attributes"], any, UpdateReq>;
  delete(input: {
    id: string;
    instanceId: string;
    olds: Props<Res>;
    output: Res["Attributes"];
    session: ScopedPlanStatusSession;
    bindings: BindingData<Res>;
  }): Effect.Effect<void, any, DeleteReq>;
}

export const getProviderByType = Effect.fnUntraced(function* <
  R extends ResourceLike,
>(resourceType: string) {
  const context = yield* Effect.context<never>();
  const provider: ProviderService<R> = context.mapUnsafe.get(resourceType);
  if (!provider) {
    return yield* Effect.die(
      new Error(`Provider not found for ${resourceType}`),
    );
  }
  return provider;
});

export const effect = <
  R extends ResourceLike,
  Req = never,
  ReadReq = never,
  DiffReq = never,
  PrecreateReq = never,
  CreateReq = never,
  UpdateReq = never,
  DeleteReq = never,
  TailReq = never,
  LogsReq = never,
>(
  cls: ResourceClass<R> | Platform<R, any, any, any, any>,
  eff: Effect.Effect<
    ProviderService<
      R,
      ReadReq,
      DiffReq,
      PrecreateReq,
      CreateReq,
      UpdateReq,
      DeleteReq,
      TailReq,
      LogsReq
    >,
    never,
    Req
  >,
): Layer.Layer<
  Provider<R>,
  never,
  Exclude<
    Req | ReadReq | DiffReq | PrecreateReq | CreateReq | UpdateReq | DeleteReq,
    LifecycleServices
  >
> =>
  // @ts-expect-error
  Layer.effect(Provider(cls.Type), eff);

export const succeed = <
  R extends ResourceLike,
  ReadReq = never,
  DiffReq = never,
  PrecreateReq = never,
  CreateReq = never,
  UpdateReq = never,
  DeleteReq = never,
  TailReq = never,
  LogsReq = never,
>(
  cls: ResourceClass<R> | Platform<R, any, any, any, any>,
  service: ProviderService<
    R,
    ReadReq,
    DiffReq,
    PrecreateReq,
    CreateReq,
    UpdateReq,
    DeleteReq,
    TailReq,
    LogsReq
  >,
): Layer.Layer<
  Provider<R>,
  never,
  Exclude<
    ReadReq | DiffReq | PrecreateReq | CreateReq | UpdateReq | DeleteReq,
    LifecycleServices
  >
> =>
  // @ts-expect-error
  Layer.succeed(Provider(cls.Type), service);
