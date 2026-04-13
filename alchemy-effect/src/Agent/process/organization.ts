import { type Aspect, defineAspect } from "../Aspect.ts";

export type Organization<
  Name extends string = string,
  References extends any[] = any[],
> = Aspect<Organization, "organization", Name, References>;

export const Organization =
  defineAspect<
    <const Name extends string>(
      name: Name,
    ) => <References extends any[]>(
      template: TemplateStringsArray,
      ...references: References
    ) => Organization<Name, References>
  >("organization");
