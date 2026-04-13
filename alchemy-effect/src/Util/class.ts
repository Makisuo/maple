export type Class<T = any> =
  | (new (...args: any[]) => T)
  | (new (_: never) => T);

export type ClassTuple<T extends any[]> = T extends [infer Head, ...infer Tail]
  ? [Class<Head>, ...ClassTuple<Tail>]
  : [];
