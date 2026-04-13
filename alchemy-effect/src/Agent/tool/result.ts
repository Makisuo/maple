import * as S from "effect/Schema";
import type { IsNever } from "../..//Util/types.ts";
import { Field } from "../../Schema.ts";
import { defineAspect, type Aspect } from "../Aspect.ts";

export const isResult = (artifact: any): artifact is Result =>
  artifact?.type === "result";

export type Result<
  ID extends string = string,
  References extends any[] = any[],
  T extends Field = Field,
> = Aspect<Result, "result", ID, References, T>;

export const Result = defineAspect<
  <const Name extends string, T extends Field = typeof S.String>(
    name: Name,
    props?: T,
  ) => <References extends any[]>(
    template: TemplateStringsArray,
    ...references: References
  ) => Result<Name, References, T>
>("result", Field);

export declare namespace Result {
  export type Of<
    References extends readonly any[],
    Outputs = never,
    Primitives = never,
  > = References extends []
    ? Outputs | Primitives extends never
      ? void
      : Outputs | Primitives
    : References extends readonly [infer Ref, ...infer Rest]
      ? Ref extends {
          type: "result";
          props: infer Schema;
          id: infer Name extends string;
        }
        ? Result.Of<
            Rest,
            (IsNever<Outputs> extends true ? {} : Outputs) & {
              [name in Name]: S.Schema.Type<Schema>;
            },
            Primitives
          >
        : Ref extends S.Schema<infer T>
          ? Result.Of<Rest, Outputs, Primitives | T>
          : Result.Of<Rest, Outputs, Primitives>
      : never;
}
