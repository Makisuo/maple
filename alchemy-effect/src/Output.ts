import * as Data from "effect/Data";
import type { Yieldable } from "effect/Effect";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import type { Pipeable } from "effect/Pipeable";
import { SingleShotGen } from "effect/Utils";
import { ExecutionContext } from "./ExecutionContext.ts";
import { getRefMetadata, isRef, ref as stageRef, type Ref } from "./Ref.ts";
import { isResource, type Resource, type ResourceLike } from "./Resource.ts";
import { Stack } from "./Stack.ts";
import { Stage } from "./Stage.ts";
import * as State from "./State/State.ts";
import { isPrimitive } from "./Util/data.ts";

const inspect = Symbol.for("nodejs.util.inspect.custom");

export const of = <R extends ResourceLike>(
  resource: Ref<R> | R,
): R extends ResourceLike
  ? ResourceExpr<R["Attributes"]>
  : RefExpr<R["Attributes"]> => {
  if (isRef(resource)) {
    const metadata = getRefMetadata(resource);
    return new RefExpr(metadata.stack, metadata.stage, metadata.id) as any;
  }
  return new ResourceExpr(resource) as any;
};

export const asOutput = <T>(t: T | Output<T> | Effect.Effect<T>): Output<T> =>
  isOutput(t)
    ? t
    : Effect.isEffect(t)
      ? new EffectExpr(VoidExpr, () => t)
      : new LiteralExpr(t);

export const isOutput = (value: any): value is Output<any> =>
  value &&
  (typeof value === "object" || typeof value === "function") &&
  ExprSymbol in value;

export interface Output<A = any, Req = any> extends Pipeable {
  /** @internal phantom */
  readonly kind: string;
  /** @internal phantom */
  readonly A: A;
  /** @internal phantom */
  readonly req: Req;
  /** @internal phantom */
  [Symbol.iterator](): Iterator<
    Yieldable<any, void, never, Req>,
    Accessor<A>,
    void
  >;
  bind(id: string): Effect.Effect<Effect.Effect<A>, never, ExecutionContext>;
  asEffect(): Effect.Effect<Accessor<A>, never, Req>;
  as<T>(): Output<T, Req>;
}

export interface Accessor<A> extends Effect.Effect<A> {}

export type ToOutput<A, Req = never> = [Extract<A, object>] extends [never]
  ? Output<A, Req>
  : [Extract<A, any[]>] extends [never]
    ? ObjectExpr<
        {
          [attr in keyof A]: A[attr];
        },
        Req
      >
    : ArrayExpr<Extract<A, any[]>, Req>;

export const ExprSymbol = Symbol.for("alchemy/Expr");

export const isExpr = (value: any): value is Expr<any> =>
  value &&
  (typeof value === "object" || typeof value === "function") &&
  ExprSymbol in value;

export type Expr<A = any, Req = any> =
  | AllExpr<Expr<A, Req>[]>
  | ApplyExpr<any, A, Req>
  | EffectExpr<any, A, Req>
  | LiteralExpr<A>
  | PropExpr<A, keyof A, Req>
  | ResourceExpr<A, Req>
  | RefExpr<A>;

export abstract class BaseExpr<A = any, Req = any> implements Output<A, Req> {
  declare readonly kind: any;
  declare readonly A: A;
  declare readonly src: ResourceLike;
  declare readonly req: Req;
  // we use a kind tag instead of instanceof to protect ourselves from duplicate alchemy-effect module imports
  constructor() {}
  as<T>(): Output<T, Req> {
    return this as any;
  }

  [Symbol.iterator](): Iterator<
    Yieldable<any, void, never, Req>,
    Accessor<A>,
    void
  > {
    // @ts-expect-error - TODO(sam): fix this (works at runtime, but maybe indicates a bad assumption)
    return new SingleShotGen(this);
  }

  asEffect(): any {
    return this.bind(this.toString());
  }

  public bind(id: string): any {
    return ExecutionContext.asEffect().pipe(
      Effect.flatMap((ctx) =>
        Effect.map(ctx.set(id, this), (key) => ctx.get<A>(key)),
      ),
    );
  }

  public pipe(...fns: any[]): any {
    // @ts-expect-error
    return pipe(this, ...fns);
  }
  public abstract [inspect](): string;
  public toString(): string {
    return this[inspect]();
  }
}
export type ObjectExpr<A, Req = any> = Output<A, Req> & {
  [Prop in keyof Exclude<A, undefined>]-?: ToOutput<
    Exclude<A, undefined>[Prop] | Extract<A, undefined>,
    Req
  >;
};

export type ArrayExpr<A extends any[], Req = any> = Output<A, Req> & {
  [i in Extract<keyof A, number>]: ToOutput<A[i], Req>;
};

export const isResourceExpr = <Value = any, Req = any>(
  node: Expr<Value, Req> | any,
): node is ResourceExpr<Value, Req> => node?.kind === "ResourceExpr";

export class ResourceExpr<Value, Req = never> extends BaseExpr<Value, Req> {
  readonly kind = "ResourceExpr";
  constructor(
    readonly src: ResourceLike,
    readonly stables?: Record<string, any>,
  ) {
    super();
    return proxy(this);
  }
  [inspect](): string {
    return this.src.LogicalId;
  }
}

export const isPropExpr = <A = any, Prop extends keyof A = keyof A, Req = any>(
  node: any,
): node is PropExpr<A, Prop, Req> => node?.kind === "PropExpr";

export class PropExpr<
  A = any,
  Id extends keyof A = keyof A,
  Req = any,
> extends BaseExpr<A[Id], Req> {
  readonly kind = "PropExpr";
  constructor(
    public readonly expr: Expr<A, Req>,
    public readonly identifier: Id,
  ) {
    super();
    return proxy(this);
  }
  [inspect](): string {
    return `${this.expr[inspect]()}.${this.identifier.toString()}`;
  }
}

export const literal = <A>(value: A) => new LiteralExpr(value);

export const isLiteralExpr = <A = any>(node: any): node is LiteralExpr<A> =>
  node?.kind === "LiteralExpr";

export class LiteralExpr<A> extends BaseExpr<A, never> {
  readonly kind = "LiteralExpr";
  constructor(public readonly value: A) {
    super();
    return proxy(this);
  }
  [inspect](): string {
    return String(this.value);
  }
}

export const VoidExpr = new LiteralExpr(void 0);

export const map: {
  <A, B>(
    fn: (value: A) => B,
  ): <Req>(output: Output<A, Req>) => ToOutput<B, Req>;
  <A, B, Req>(output: Output<A, Req>, fn: (value: A) => B): ToOutput<B, Req>;
} = (<A, B, Req>(
  ...args: [fn: (value: A) => B] | [output: Output<A, Req>, fn: (value: A) => B]
) =>
  args.length === 1
    ? <Req>(output: Output<A, Req>): ToOutput<B, Req> =>
        new ApplyExpr(output as Expr<A, Req>, args[0]) as any
    : new ApplyExpr(args[0] as any, args[1])) as any;

type _ = Parameters<typeof map>;

//Output.ApplyExpr<any, any, ResourceLike, any>
export const isApplyExpr = <In = any, Out = any, Req = any>(
  node: Output<Out, Req>,
): node is ApplyExpr<In, Out, Req> => node?.kind === "ApplyExpr";

export class ApplyExpr<A, B, Req = never> extends BaseExpr<B, Req> {
  readonly kind = "ApplyExpr";
  constructor(
    public readonly expr: Expr<A, Req>,
    public readonly f: (value: A) => B,
  ) {
    super();
    return proxy(this);
  }

  [inspect](): string {
    return `${this.expr[inspect]()}.map(${this.f.toString()})`;
  }
}

export const mapEffect =
  <A, B, Req2>(fn: (value: A) => Effect.Effect<B, never, Req2>) =>
  <Req>(output: Output<A, Req>): ToOutput<B, Req | Req2> =>
    new EffectExpr(output as Expr<A, Req>, fn) as any;

export const isEffectExpr = <In = any, Out = any, Req = any, Req2 = any>(
  node: any,
): node is EffectExpr<In, Out, Req, Req2> => node?.kind === "EffectExpr";

export class EffectExpr<A, B, Req = never, Req2 = never> extends BaseExpr<
  B,
  Req
> {
  readonly kind = "EffectExpr";
  constructor(
    public readonly expr: Expr<A, Req>,
    public readonly f: (value: A) => Effect.Effect<B, never, Req2>,
  ) {
    super();
    return proxy(this);
  }
  [inspect](): string {
    return `${this.expr[inspect]()}.mapEffect(${this.f.toString()})`;
  }
}

export const all = <Outs extends (Output | Expr)[]>(...outs: Outs) =>
  new AllExpr(outs as any) as unknown as All<Outs>;

export type All<Outs extends (Output | Expr)[]> = number extends Outs["length"]
  ? [Outs[number]] extends [
      Output<infer V, infer Req> | Expr<infer V, infer Req>,
    ]
    ? Output<V, Req>
    : never
  : Tuple<Outs>;

type Tuple<
  Outs extends (Output | Expr)[],
  Values extends any[] = [],
  Req = never,
> = Outs extends [infer H, ...infer Tail extends (Output | Expr)[]]
  ? H extends Output<infer V, infer Req2>
    ? Tuple<Tail, [...Values, V], Req | Req2>
    : never
  : Output<Values, Req>;

export const isAllExpr = <Outs extends Expr[] = Expr[]>(
  node: any,
): node is AllExpr<Outs> => node?.kind === "AllExpr";

export class AllExpr<Outs extends Expr[]> extends BaseExpr<Outs> {
  readonly kind = "AllExpr";
  constructor(public readonly outs: Outs) {
    super();
    return proxy(this);
  }
  [inspect](): string {
    return `all(${this.outs.map((out) => out[inspect]()).join(", ")})`;
  }
}

export const isRefExpr = <A = any>(node: any): node is RefExpr<A> =>
  node?.kind === "RefExpr";

export class RefExpr<A> extends BaseExpr<A, never> {
  readonly kind = "RefExpr";
  constructor(
    public readonly stack: string | undefined,
    public readonly stage: string | undefined,
    public readonly resourceId: string,
  ) {
    super();
    return proxy(this);
  }
  [inspect](): string {
    return `ref(${this.resourceId}, { stack: ${this.stack}, stage: ${this.stage} })`;
  }
}

export const filter = <Outs extends any[]>(...outs: Outs) =>
  outs.filter(isOutput) as unknown as Filter<Outs>;

export type Filter<Outs extends any[]> = number extends Outs["length"]
  ? Output<
      Extract<Outs[number], Output>["value"],
      Extract<Outs[number], Output>["req"]
    >
  : FilterTuple<Outs>;

export type FilterTuple<
  Outs extends (Output | Expr)[],
  Values extends any[] = [],
> = Outs extends [infer H, ...infer Tail extends (Output | Expr)[]]
  ? H extends Output<infer V>
    ? FilterTuple<Tail, [...Values, V]>
    : FilterTuple<Tail, Values>
  : Output<Values>;

export const interpolate = <Args extends any[]>(
  template: TemplateStringsArray,
  ...args: Args
): All<Args> extends Output<any, infer Req> ? Output<string, Req> : never =>
  all(...args.map((arg) => (isOutput(arg) ? arg : literal(arg)))).pipe(
    map((args) =>
      template
        .map((str, i) => str + (args[i] == null ? "" : String(args[i])))
        .join(""),
    ),
  ) as any;

function proxy(self: any): any {
  const target = Object.assign(() => {}, self);
  if (inspect in self) {
    Object.defineProperty(target, inspect, {
      value: self[inspect].bind(self),
      configurable: true,
    });
  }
  const proxy = new Proxy(target, {
    has: (_, prop) =>
      prop === ExprSymbol || prop === inspect ? true : prop in self,
    get: (target, prop) =>
      prop === Symbol.toPrimitive
        ? (hint: string) => (hint === "string" ? self.toString() : self)
        : prop === ExprSymbol
          ? self
          : prop === inspect
            ? target[inspect]
            : isResourceExpr(self) && self.stables && prop in self.stables
              ? self.stables[prop as keyof typeof self.stables]
              : prop === "apply"
                ? self[prop]
                : prop in self
                  ? typeof self[prop as keyof typeof self] === "function" &&
                    !("kind" in self)
                    ? new PropExpr(proxy, prop as never)
                    : self[prop as keyof typeof self]
                  : new PropExpr(proxy, prop as never),
    apply: (_, thisArg, args) => {
      if (isPropExpr(self)) {
        if (self.identifier === "apply") {
          return new ApplyExpr(self.expr, args[0]);
        } else if (self.identifier === "effect") {
          return new EffectExpr(self.expr, args[0]);
        }
      }
      return undefined;
    },
  });
  return proxy;
}

/// Evaluation

export class MissingSourceError extends Data.TaggedError("MissingSourceError")<{
  message: string;
  srcId: string;
}> {}

export class InvalidReferenceError extends Data.TaggedError(
  "InvalidReferenceError",
)<{
  message: string;
  stack: string;
  stage: string;
  resourceId: string;
}> {}

export const evaluate: <A, Req = never>(
  expr: Output<A, Req> | A,
  upstream: {
    [Id in string]: any;
  },
) => Effect.Effect<
  A,
  InvalidReferenceError | MissingSourceError,
  State.State | Req
> = (expr, upstream) =>
  Effect.gen(function* () {
    if (isResource(expr)) {
      const srcId = expr.FQN;
      const src = upstream[srcId as keyof typeof upstream];
      if (!src) {
        // type-safety should prevent this but let the caller decide how to handle it
        return yield* new MissingSourceError({
          message: `Source ${srcId} not found`,
          srcId,
        });
      }
      return src;
    } else if (isOutput(expr)) {
      if (isResourceExpr(expr)) {
        const srcId = expr.src.FQN;
        const src = upstream[srcId as keyof typeof upstream];
        if (!src) {
          // type-safety should prevent this but let the caller decide how to handle it
          return yield* new MissingSourceError({
            message: `Source ${srcId} not found`,
            srcId,
          });
        }
        return src;
      } else if (isLiteralExpr(expr)) {
        return expr.value;
      } else if (isApplyExpr(expr)) {
        return expr.f(yield* evaluate(expr.expr, upstream));
      } else if (isEffectExpr(expr)) {
        // TODO(sam): the same effect shoudl be memoized so that it's not run multiple times
        return yield* expr.f(yield* evaluate(expr.expr, upstream));
      } else if (isAllExpr(expr)) {
        return yield* Effect.all(
          expr.outs.map((out) => evaluate(out, upstream)),
        );
      } else if (isPropExpr(expr)) {
        return (yield* evaluate(expr.expr, upstream))?.[expr.identifier];
      } else if (isRefExpr(expr)) {
        const state = yield* State.State;
        const stack = expr.stack ?? (yield* Stack).name;
        const stage = expr.stage ?? (yield* Stage);
        const resource = yield* state.get({
          stack,
          stage,
          fqn: expr.resourceId,
        });
        if (!resource) {
          return yield* Effect.fail(
            new InvalidReferenceError({
              message: `Reference to '${expr.resourceId}' in stack '${stack}' and stage '${stage}' not found. Have you deployed '${stage}' or '${stack}'?`,
              stack,
              stage,
              resourceId: expr.resourceId,
            }),
          );
        }
        return resource.attr;
      }
    }
    if (Array.isArray(expr)) {
      return yield* Effect.all(expr.map((item) => evaluate(item, upstream)));
    } else if (typeof expr === "object" && expr !== null) {
      return Object.fromEntries(
        yield* Effect.all(
          Object.entries(expr).map(([key, value]) =>
            evaluate(value, upstream).pipe(Effect.map((value) => [key, value])),
          ),
        ),
      );
    }
    return expr;
  }) as Effect.Effect<any>;

export const ref = <R extends ResourceLike>(
  resourceId: R["LogicalId"],
  options?: {
    stage?: string;
    stack?: string;
  },
) => of(stageRef({ id: resourceId, ...options }));

export const hasOutputs = (value: any): value is Output<any, any> =>
  Object.keys(upstreamAny(value)).length > 0;

export const upstreamAny = (
  value: any,
): {
  [ID in string]: Resource;
} => {
  if (isExpr(value)) {
    return upstream(value);
  } else if (Array.isArray(value)) {
    return Object.assign({}, ...value.map(resolveUpstream));
  } else if (
    value &&
    (typeof value === "object" || typeof value === "function")
  ) {
    return Object.assign(
      {},
      ...Object.values(value).map((value) => resolveUpstream(value)),
    );
  }
  return {};
};

// TODO(sam): add a type
export const upstream = <E extends Output<any, any>>(expr: E): any => {
  if (isResourceExpr(expr)) {
    return {
      [expr.src.FQN]: expr.src,
    };
  } else if (isPropExpr(expr)) {
    return upstream(expr.expr);
  } else if (isAllExpr(expr)) {
    return Object.assign({}, ...expr.outs.map((out) => upstream(out)));
  } else if (isEffectExpr(expr) || isApplyExpr(expr)) {
    return upstream(expr.expr);
  } else if (Array.isArray(expr)) {
    return expr.map(upstream).reduce(toObject, {});
  } else if (typeof expr === "object" && expr !== null) {
    return Object.values(expr)
      .map((v) => upstream(v))
      .reduce(toObject, {});
  }
  return {};
};

// TODO(sam): add a type
export const resolveUpstream = <const A>(value: A): any => {
  if (isPrimitive(value)) {
    return {} as any;
  } else if (isOutput(value)) {
    return upstream(value) as any;
  } else if (Array.isArray(value)) {
    return Object.fromEntries(
      value.map((v) => resolveUpstream(v)).flatMap(Object.entries),
    ) as any;
  } else if (typeof value === "object" || typeof value === "function") {
    return Object.fromEntries(
      Object.values(value as any)
        .map(resolveUpstream)
        .flatMap(Object.entries),
    ) as any;
  }
  return {} as any;
};

const toObject = <A, B>(acc: B, v: A) => ({
  ...acc,
  ...v,
});

export const log = <A>(_value: A) =>
  Effect.gen(function* () {
    // TODO(sam): implement a log effect
  });

export const toEnvKey = <const ID extends string, const Suffix extends string>(
  id: ID,
  suffix: Suffix,
) => `${replace(toUpper(id))}_${replace(toUpper(suffix))}` as const;

export const toUpper = <const S extends string>(str: S) =>
  str.toUpperCase() as string extends S ? S : Uppercase<S>;

const replace = <const S extends string>(str: S) =>
  str.replace(/-/g, "_") as Replace<S>;

type Replace<S extends string, Accum extends string = ""> = string extends S
  ? S
  : S extends ""
    ? Accum
    : S extends `${infer S}${infer Rest}`
      ? S extends "-"
        ? Replace<Rest, `${Accum}_`>
        : Replace<Rest, `${Accum}${S}`>
      : Accum;
