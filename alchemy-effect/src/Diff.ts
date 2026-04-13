import * as Effect from "effect/Effect";
import type { Input } from "./Input.ts";
import * as Output from "./Output.ts";
import type { BindingNode } from "./Plan.ts";
import type { ResourceBinding } from "./Resource.ts";
import { isPrimitive } from "./Util/data.ts";

export type Diff = NoopDiff | UpdateDiff | ReplaceDiff;

export interface NoopDiff {
  action: "noop";
  stables?: undefined;
}

export interface UpdateDiff {
  action: "update";
  /** properties that won't change as part of this update */
  stables?: string[];
}

export interface ReplaceDiff {
  action: "replace";
  deleteFirst?: boolean;
  stables?: undefined;
}

/**
 * Returns true when `value` (or any nested leaf) is still an unresolved
 * plan-time expression — i.e. an `Output`/`Expr` or an `Effect` that was
 * not fully evaluated by `resolveInput` in Plan.ts.
 *
 * Use at the top of a provider `diff` to short-circuit before field access:
 *
 * ```ts
 * if (!isResolved(news)) return undefined;
 * const resolved = news as MyProps;
 * ```
 */
export const hasUnresolvedInputs = <T>(value: Input<NoInfer<T>>): value is T =>
  _hasUnresolved(value);

export const isResolved = <T>(value: Input<T>): value is T =>
  !_hasUnresolved(value);

const _hasUnresolved = (value: unknown): boolean => {
  if (value == null || isPrimitive(value)) return false;
  if (Output.isExpr(value) || Effect.isEffect(value)) return true;
  if (Array.isArray(value)) return value.some(_hasUnresolved);
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(_hasUnresolved);
  }
  return false;
};

export const somePropsAreDifferent = <Props extends Record<string, any>>(
  olds: Props,
  news: Props,
  props: (keyof Props)[],
) => {
  for (const prop of props) {
    if (olds[prop] !== news[prop]) {
      return true;
    }
  }
  return false;
};

export const anyPropsAreDifferent = <Props extends Record<string, any>>(
  olds: Props,
  news: Props,
) => {
  for (const prop in olds) {
    if (olds[prop] !== news[prop]) {
      return true;
    }
  }
  for (const prop in news) {
    if (!(prop in olds)) {
      return true;
    }
  }
  return false;
};

export const havePropsChanged = <Props extends object>(
  oldProps: Props | undefined,
  newProps: Props,
) =>
  Output.hasOutputs(newProps) ||
  JSON.stringify(canonicalize(oldProps ?? {})) !==
    JSON.stringify(canonicalize(newProps ?? {}));

/**
 * Sort-keys deep equality for plain data (objects, arrays, primitives).
 * Use in provider `diff` handlers instead of ad-hoc `JSON.stringify` comparisons.
 */
export const deepEqual = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonicalize(a ?? undefined)) ===
  JSON.stringify(canonicalize(b ?? undefined));

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
};

export const diffBindings = (
  oldBindings: ResourceBinding[],
  newBindings: ResourceBinding[],
): BindingNode[] => {
  const oldMap = new Map(oldBindings.map((b) => [b.sid, b]));
  const newMap = new Map(newBindings.map((b) => [b.sid, b]));
  return [
    ...Array.from(oldMap)
      .filter(([sid]) => !newMap.has(sid))
      .map(([sid, old]) => ({
        sid,
        action: "delete" as const,
        data: old.data,
      })),
    ...Array.from(newMap).map(([sid, binding]) => {
      const old = oldMap.get(sid);
      return {
        sid,
        action: (!old
          ? "create"
          : havePropsChanged(old.data, binding.data)
            ? "update"
            : "noop") as BindingNode["action"],
        data: binding.data,
      };
    }),
  ];
};
