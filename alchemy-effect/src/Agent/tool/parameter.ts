import * as S from "effect/Schema";
import { Field } from "../../Schema.ts";
import { defineAspect, type Aspect } from "../Aspect.ts";

export const isParameter = (artifact: any): artifact is Parameter =>
  artifact?.type === "param";

export type Parameter<
  ID extends string = string,
  References extends any[] = any[],
  T extends Field = Field,
> = Aspect<Parameter, "param", ID, References, T>;

export const Parameter = defineAspect<
  <const Name extends string, Schema extends Field = typeof S.String>(
    name: Name,
    schema?: Schema,
  ) => <References extends any[]>(
    template: TemplateStringsArray,
    ...references: References
  ) => Parameter<Name, References, Schema>
>("param", Field);

export declare namespace Parameters {
  export type Of<
    References extends any[],
    Fields extends S.Struct.Fields = {},
  > = References extends []
    ? S.Struct<Fields>["Type"]
    : References extends [infer Artifact, ...infer Rest]
      ? Artifact extends Parameter<infer ID extends string, any[], infer Field>
        ? Parameters.Of<Rest, Fields & { [name in ID]: Field }>
        : Parameters.Of<Rest, Fields>
      : [];
}
