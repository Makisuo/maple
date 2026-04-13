export type Pointer<T> = T | (() => T);

export declare namespace Pointer {
  export type Resolve<R> = R extends () => infer T ? T : R;
}
