export type Instance<T> = T extends new (_: never) => infer I
  ? I
  : T extends { id: string }
    ? string extends T["id"]
      ? T
      : T extends new (...args: any) => infer I
        ? I
        : never
    : never;
