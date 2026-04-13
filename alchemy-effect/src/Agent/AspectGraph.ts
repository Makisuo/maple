import * as Context from "effect/Context";
import * as S from "effect/Schema";
import type { Instance } from "..//Util/instance.ts";
import type { Pointer } from "..//Util/pointer.ts";
import { isAspect, type Aspect, type AspectLike } from "./Aspect.ts";

export class AspectGraph extends Context.Service<
  AspectGraph,
  {
    aspects: AspectIndex<AspectLike>;
    schema: S.Schema<AspectIndex>;
  }
>()("AspectGraphService") {}

export type AspectIndex<A extends AspectLike = AspectLike> = {
  [type in AspectSet<A>["type"]]: {
    [id in Extract<AspectSet<A>, { type: type }>["id"]]: Extract<
      Extract<AspectSet<A>, { type: type }>,
      { id: id }
    >;
  };
};

export type AspectCategory<Aspects extends Aspect> = {
  [id in keyof Aspects["id"]]: Extract<Aspects, { id: id }>;
};

export type AspectSet<A extends AspectLike = any> =
  | A
  | Visit<A["references"][number], FQN<A>>;

type Visit<Value, Seen extends string = never> =
  Pointer.Resolve<Value> extends infer A
    ? A extends {
        type: string;
        id: string;
        references: infer References extends any[];
      }
      ? FQN<A> extends Seen
        ? never
        : Instance<A> | Visit<References[number], Seen | FQN<A>>
      : A extends readonly (infer I)[]
        ? Visit<I, Seen>
        : A extends Record<string, infer V>
          ? Visit<V, Seen>
          : never
    : never;

type FQN<A extends { type: string; id: string } = any> = A["id"] extends string
  ? `${A["type"]}:${A["id"]}`
  : never;

const getFqn = <A extends { type: string; id: string }>(a: A): FQN<A> =>
  `${a.type}:${a.id}` as FQN<A>;

export type AspectKinds<A extends Aspect> = {
  [type in keyof AspectIndex<A>]: {
    // @ts-expect-error
    [id in keyof AspectIndex<A>[type]]: InstanceType<
      // @ts-expect-error
      AspectIndex<A>[type][id]["class"]
    >;
    // @ts-expect-error
  }[keyof AspectIndex<A>[type]];
}[keyof AspectIndex<A>];

export const deriveGraph = <A extends AspectLike>(agent: A): AspectIndex<A> => {
  const seen = new Set<FQN>();
  return [agent, ...agent.references.flatMap((v) => visit(v, seen))].reduce(
    (acc: AspectIndex<A>, aspect) => ({
      ...acc,
      [aspect.type]: {
        ...acc[aspect.type as keyof AspectIndex<A>],
        [aspect.id as keyof AspectIndex<A>[keyof AspectIndex<A>]]: aspect,
      },
    }),
    {} as AspectIndex<A>,
  );
};

const visit = <A>(a: A, seen: Set<FQN>): Aspect[] => {
  if (isAspect(a)) {
    const fqn = getFqn(a);
    if (!seen.has(fqn)) {
      seen.add(fqn);
      return [a, ...a.references.flatMap((v) => visit(v, seen))];
    }
  } else if (Array.isArray(a)) {
    return a.flatMap((v) => visit(v, seen));
  } else if (a instanceof Set) {
    return Array.from(a).flatMap((v) => visit(v, seen));
  } else if (a instanceof Map) {
    return Array.from(a.values()).flatMap((v) => visit(v, seen));
  } else if (typeof a === "object" && a !== null) {
    return Object.values(a).flatMap((v) => visit(v, seen));
  }
  return [];
};
