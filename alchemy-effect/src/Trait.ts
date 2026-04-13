import type { ClassTuple } from ".//Util/class.ts";
import * as S from "./Schema.ts";

export declare function defineTrait<F extends TraitFn>(
  tag: NoInfer<ReturnType<F>["tag"]>,
  fn: F,
): TraitDef<F>;

export declare function defineTrait<T extends Trait>(
  tag: T["tag"],
  props: {
    [k in keyof TraitProps<T>]: TraitProps<T>[k];
  },
): TraitDef<<Target>(target: Target) => ApplyTrait<Target, T>>;

export const applyTrait = <T extends Trait<any, any, any>>(
  tag: T["tag"],
  props: {
    [k in keyof TraitProps<T>]: TraitProps<T>[k];
  },
): T => undefined!;

export type AnyTrait = Trait<any, any, any>;

export type TraitFn<
  T extends AnyTrait = AnyTrait,
  Args extends any[] = any[],
> = (...args: Args) => T;

export type TraitDef<Fn extends TraitFn = TraitFn> = Fn & {
  /** @internal phantom */
  trait: ReturnType<Fn>;
};

export interface Trait<
  Tag extends string = string,
  Errors extends any[] = never,
  Provides extends any[] = never,
> {
  type?: "trait";
  tag: Tag;
  errors?: ClassTuple<Errors>;
  provides?: ClassTuple<Provides>;
}

export type TraitError<A extends Trait<any, any, any>> = InstanceType<
  Exclude<A["errors"], undefined>[number]
>;

export type TraitProps<A extends Trait<any, any, any>> = {
  [k in keyof _TraitProps<A>]: _TraitProps<A>[k];
};

type _TraitProps<A extends Trait<any, any, any>> = Omit<
  A,
  "type" | "tag" | "provides" | "errors"
> &
  (A["errors"] extends never | undefined
    ? {}
    : {
        errors: Exclude<A["errors"], undefined>;
      }) &
  (A["provides"] extends never | undefined
    ? {}
    : {
        provides: Exclude<A["provides"], undefined>;
      });

export type ApplyTrait<Target, T extends Trait<any, any, any>> = ([
  Target,
] extends [Annotated<infer s, infer t>]
  ? Annotated<s, T | t>
  : [Target] extends [S.Top]
    ? Annotated<Target, T>
    : [Target] extends [S.AnyClassSchema]
      ? Annotated<Target, T | Annotated.Unwrap<Target>>
      : Target) & {};

export type Annotated<S, T extends Trait<any, any, any>> = S & {
  /** @internal phantom type */
  S: S;
  type: "annotated";
  /** @internal phatom */
  traits: T;
};

export declare namespace Annotated {
  export type Unwrap<T> = T extends Annotated<infer _, infer t> ? t : never;
}

// export declare namespace Traits {
//   export type Of<C, Seen = never> = C extends Seen
//     ? never
//     : C extends Annotated<infer S, infer T>
//       ? T | Of<S, Seen>
//       : C extends AnyClassSchema
//         ? OfFields<C["fields"], Seen | C>
//         : C extends S.Struct<any>
//           ? OfFields<C["fields"], Seen | C>
//           : never;

//   type OfFields<F extends S.Struct.Fields, Seen> = {
//     [prop in keyof F]: Of<F[prop], Seen>;
//   }[keyof F];
// }
