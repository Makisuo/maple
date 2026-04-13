export type Primitive =
  | never
  | undefined
  | null
  | boolean
  | number
  | string
  | bigint
  | symbol;

export const isPrimitive = (value: any): value is Primitive =>
  value === undefined ||
  value === null ||
  typeof value === "boolean" ||
  typeof value === "number" ||
  typeof value === "string" ||
  typeof value === "symbol" ||
  typeof value === "bigint";
