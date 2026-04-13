import { Context, Layer, Option } from "effect"

export interface WorkerBindingsShape {
  readonly values: Readonly<Record<string, unknown>>
  readonly get: (key: string) => Option.Option<unknown>
}

export class WorkerBindings extends Context.Service<
  WorkerBindings,
  WorkerBindingsShape
>()("WorkerBindings") {
  static readonly layer = (values: Record<string, unknown>) =>
    Layer.succeed(this, {
      values,
      get: (key: string) =>
        values[key] == null ? Option.none() : Option.some(values[key]),
    } satisfies WorkerBindingsShape)
}

export const getWorkerBinding = (
  bindings: WorkerBindingsShape,
  key: string,
): Option.Option<unknown> => bindings.get(key)

export const getWorkerBindingString = (
  bindings: WorkerBindingsShape,
  key: string,
): Option.Option<string> =>
  Option.flatMap(getWorkerBinding(bindings, key), (value) =>
    typeof value === "string" && value.trim().length > 0
      ? Option.some(value)
      : Option.none(),
  )
