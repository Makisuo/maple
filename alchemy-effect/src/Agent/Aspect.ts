import * as Context from "effect/Context";
import type { Yieldable } from "effect/Effect";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import type { Class, IsAny } from "../Util/index.ts";
import { ContextPlugin } from "./ContextPlugin.ts";
import { createPluginBuilder, type Plugins } from "./Plugin.ts";
import { type Parameters } from "./tool/parameter.ts";
import type { Result } from "./tool/result.ts";
import type { ToolHandler } from "./tool/tool.ts";

export const isAspect = (a: any): a is Aspect => {
  return (
    typeof a === "object" &&
    a !== null &&
    "type" in a &&
    "id" in a &&
    "template" in a &&
    "references" in a &&
    "fields" in a &&
    "schema" in a
  );
};

export class AspectConfig extends Context.Service<
  AspectConfig,
  {
    cwd: string;
  }
>()("AspectConfig") {}

export type AspectClass<Fn extends AspectType<any>> = Fn & {
  kind: "aspect";
  type: string;
  schema: GetAspectType<Fn>["schema"];
  plugin: Plugins<GetAspectType<Fn>>;
  with<T>(context: T): AspectClass<Fn> & T;
};

export type AspectLike = {
  kind: "aspect";
  id: string;
  type: string;
  references: any[];
};

export interface Aspect<
  Self = any,
  Type extends string = string,
  Name extends string = string,
  References extends any[] = any[],
  Props = any,
  Handler extends ToolHandler<References> = ToolHandler<References>,
> {
  kind: "aspect";
  class: Class<Self>;
  type: Type;
  id: Name;
  props: Props;
  template: TemplateStringsArray;
  references: References;
  schema: IsAny<Props> extends true
    ? any
    : [Props] extends [S.Top]
      ? S.Schema<Props>
      : [Props] extends [object]
        ? Class<Props> & S.Schema<Props>
        : S.Schema<Props>;
  handle: Handler;
  new (): Aspect<Self, Type, Name, References, Props>;
}

export const defineAspect: <Fn extends AspectType<any>>(
  type: GetAspectType<Fn>["type"],
  ...props: GetAspectType<Fn>["schema"] extends infer Schema
    ? Schema extends Class<infer C>
      ? IsAny<C> extends true
        ? []
        : [C] extends [S.Top]
          ? [schema: S.Schema<C>]
          : [C] extends [object]
            ? [cls: Class<C>]
            : [schema: S.Schema<C>]
      : IsAny<Schema> extends true
        ? []
        : [Schema]
    : []
) => AspectClass<Fn> = ((type: string, schema: any) =>
  Object.assign(
    (name: string, data: any) =>
      (template: TemplateStringsArray, ...references: any[]) => {
        const aspect = (handler: any) => ({
          kind: "aspect",
          type,
          id: name,
          template,
          references,
          schema,
          data,
          handler,
          plugin: {
            context: createPluginBuilder(ContextPlugin(type) as any),
          },
        });
        // function declaration so that a class can extends this
        return Object.assign(function (handler: any) {
          return Object.assign(function () {}, aspect(handler));
        }, aspect(undefined));
      },
    {
      kind: "aspect",
      type,
      schema,
      plugin: {
        context: createPluginBuilder(ContextPlugin(type) as any),
      },
    },
  )) as AspectClass<any>;

type AspectType<Props = any> = AspectObject<Props> | AspectFunction<Props>;

type AspectObject<Props = any> = <Name extends string>(
  name: Name,
  props?: Props,
) => <References extends any[]>(
  template: TemplateStringsArray,
  ...references: References
) => Aspect<Aspect, string, Name, References, Props>;

type AspectFunction<Props = any> = <Name extends string>(
  name: Name,
  props?: Props,
) => <References extends any[]>(
  template: TemplateStringsArray,
  ...references: References
) =>
  | (<Eff extends Yieldable<any, any, any, any>>(
      handler: (
        input: Parameters.Of<References>,
      ) => Generator<Eff, NoInfer<Result.Of<References>>, never>,
    ) => Aspect<
      Aspect,
      string,
      Name,
      References,
      Props,
      (
        input: Parameters.Of<References>,
      ) => Effect.Effect<
        NoInfer<Result.Of<References>>,
        [Eff] extends [never]
          ? never
          : [Eff] extends [Yieldable<any, infer _A, infer E, infer _R>]
            ? E
            : never,
        [Eff] extends [never]
          ? never
          : [Eff] extends [Yieldable<any, infer _A, infer _E, infer R>]
            ? R
            : never
      >
    >)
  | (<Handler extends ToolHandler<References>>(
      handler: Handler,
    ) => Aspect<Aspect, string, Name, References, Props, Handler>);

type GetAspectType<Fn> = Fn extends (name: string, props?: any) => infer Return
  ? Return extends (...args: any[]) => infer Return2
    ? Return2 extends (...args: any[]) => infer Return3
      ? Return3
      : Return2
    : never
  : never;
