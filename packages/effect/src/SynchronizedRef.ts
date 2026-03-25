/**
 * @since 2.0.0
 */
import * as Effect from "./Effect.ts"
import { dual } from "./Function.ts"
import { PipeInspectableProto } from "./internal/core.ts"
import * as Option from "./Option.ts"
import * as Ref from "./Ref.ts"
import * as Semaphore from "./Semaphore.ts"

const TypeId = "~effect/SynchronizedRef"

/**
 * @since 2.0.0
 * @category models
 */
export interface SynchronizedRef<in out A> extends Ref.Ref<A> {
  readonly [TypeId]: typeof TypeId
  readonly backing: Ref.Ref<A>
  readonly semaphore: Semaphore.Semaphore
}

const Proto = {
  ...PipeInspectableProto,
  [TypeId]: TypeId,
  toJSON(this: SynchronizedRef<any>) {
    return {
      _id: "SynchronizedRef",
      value: this.backing.ref.current
    }
  }
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const makeUnsafe = <A>(value: A): SynchronizedRef<A> => {
  const self = Object.create(Proto)
  self.semaphore = Semaphore.makeUnsafe(1)
  self.backing = Ref.makeUnsafe(value)
  return self
}

/**
 * @since 2.0.0
 * @category constructors
 */
export const make = <A>(value: A): Effect.Effect<SynchronizedRef<A>> => Effect.sync(() => makeUnsafe(value))

/**
 * @since 2.0.0
 * @category getters
 */
export const getUnsafe = <A>(self: SynchronizedRef<A>): A => self.backing.ref.current

/**
 * @since 2.0.0
 * @category getters
 */
export const get = <A>(self: SynchronizedRef<A>): Effect.Effect<A> => Effect.sync(() => getUnsafe(self))

/**
 * @since 2.0.0
 * @category utils
 */
export const getAndSet: {
  <A>(value: A): (self: SynchronizedRef<A>) => Effect.Effect<A>
  <A>(self: SynchronizedRef<A>, value: A): Effect.Effect<A>
} = dual(
  2,
  <A>(self: SynchronizedRef<A>, value: A): Effect.Effect<A> =>
    self.semaphore.withPermit(Ref.getAndSet(self.backing, value))
)

/**
 * @since 2.0.0
 * @category utils
 */
export const getAndUpdate: {
  <A>(f: (a: A) => A): (self: SynchronizedRef<A>) => Effect.Effect<A>
  <A>(self: SynchronizedRef<A>, f: (a: A) => A): Effect.Effect<A>
} = dual(
  2,
  <A>(self: SynchronizedRef<A>, f: (a: A) => A): Effect.Effect<A> =>
    self.semaphore.withPermit(Ref.getAndUpdate(self.backing, f))
)

/**
 * @since 2.0.0
 * @category utils
 */
export const getAndUpdateEffect: {
  <A, R, E>(f: (a: A) => Effect.Effect<A, E, R>): (self: SynchronizedRef<A>) => Effect.Effect<A, E, R>
  <A, R, E>(self: SynchronizedRef<A>, f: (a: A) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
} = dual(
  2,
  <A, R, E>(self: SynchronizedRef<A>, f: (a: A) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    self.semaphore.withPermit(Effect.suspend(() => {
      const value = getUnsafe(self)
      return Effect.map(f(value), (newValue) => {
        self.backing.ref.current = newValue
        return value
      })
    }))
)

/**
 * @since 2.0.0
 * @category utils
 */
export const getAndUpdateSome: {
  <A>(pf: (a: A) => Option.Option<A>): (self: SynchronizedRef<A>) => Effect.Effect<A>
  <A>(self: SynchronizedRef<A>, pf: (a: A) => Option.Option<A>): Effect.Effect<A>
} = dual(
  2,
  <A>(self: SynchronizedRef<A>, pf: (a: A) => Option.Option<A>): Effect.Effect<A> =>
    self.semaphore.withPermit(Ref.getAndUpdateSome(self, pf))
)

/**
 * @since 2.0.0
 * @category utils
 */
export const getAndUpdateSomeEffect: {
  <A, R, E>(pf: (a: A) => Effect.Effect<Option.Option<A>, E, R>): (self: SynchronizedRef<A>) => Effect.Effect<A, E, R>
  <A, R, E>(self: SynchronizedRef<A>, pf: (a: A) => Effect.Effect<Option.Option<A>, E, R>): Effect.Effect<A, E, R>
} = dual(
  2,
  <A, R, E>(self: SynchronizedRef<A>, pf: (a: A) => Effect.Effect<Option.Option<A>, E, R>): Effect.Effect<A, E, R> =>
    self.semaphore.withPermit(Effect.suspend(() => {
      const value = getUnsafe(self)
      return Effect.flatMap(pf(value), (option) => {
        if (Option.isNone(option)) {
          return Effect.succeed(value)
        }
        self.backing.ref.current = option.value
        return Effect.succeed(value)
      })
    }))
)

/**
 * @since 2.0.0
 * @category utils
 */
export const modify: {
  <A, B>(f: (a: A) => readonly [B, A]): (self: SynchronizedRef<A>) => Effect.Effect<B>
  <A, B>(self: SynchronizedRef<A>, f: (a: A) => readonly [B, A]): Effect.Effect<B>
} = dual(
  2,
  <A, B>(self: SynchronizedRef<A>, f: (a: A) => readonly [B, A]): Effect.Effect<B> =>
    self.semaphore.withPermit(Ref.modify(self.backing, f))
)

/**
 * @since 2.0.0
 * @category utils
 */
export const modifyEffect: {
  <A, B, E, R>(f: (a: A) => Effect.Effect<readonly [B, A], E, R>): (self: SynchronizedRef<A>) => Effect.Effect<B, E, R>
  <A, B, E, R>(self: SynchronizedRef<A>, f: (a: A) => Effect.Effect<readonly [B, A], E, R>): Effect.Effect<B, E, R>
} = dual(
  2,
  <A, B, E, R>(self: SynchronizedRef<A>, f: (a: A) => Effect.Effect<readonly [B, A], E, R>): Effect.Effect<B, E, R> =>
    self.semaphore.withPermit(Effect.suspend(() => {
      const value = getUnsafe(self)
      return Effect.map(f(value), ([b, a]) => {
        self.backing.ref.current = a
        return b
      })
    }))
)

/**
 * @since 2.0.0
 * @category utils
 */
export const modifySome: {
  <B, A>(
    pf: (a: A) => readonly [B, Option.Option<A>]
  ): (self: SynchronizedRef<A>) => Effect.Effect<B>
  <A, B>(
    self: SynchronizedRef<A>,
    pf: (a: A) => readonly [B, Option.Option<A>]
  ): Effect.Effect<B>
} = dual(
  2,
  <A, B>(
    self: SynchronizedRef<A>,
    pf: (a: A) => readonly [B, Option.Option<A>]
  ): Effect.Effect<B> => self.semaphore.withPermit(Ref.modifySome(self.backing, pf))
)

/**
 * @since 2.0.0
 * @category utils
 */
export const modifySomeEffect: {
  <A, B, R, E>(
    fallback: B,
    pf: (a: A) => Effect.Effect<readonly [B, Option.Option<A>], E, R>
  ): (self: SynchronizedRef<A>) => Effect.Effect<B, E, R>
  <A, B, R, E>(
    self: SynchronizedRef<A>,
    pf: (a: A) => Effect.Effect<readonly [B, Option.Option<A>], E, R>
  ): Effect.Effect<B, E, R>
} = dual(
  2,
  <A, B, R, E>(
    self: SynchronizedRef<A>,
    pf: (a: A) => Effect.Effect<readonly [B, Option.Option<A>], E, R>
  ): Effect.Effect<B, E, R> =>
    self.semaphore.withPermit(Effect.suspend(() => {
      const value = getUnsafe(self)
      return Effect.flatMap(pf(value), ([b, maybeA]) => {
        if (Option.isNone(maybeA)) {
          return Effect.succeed(b)
        }
        self.backing.ref.current = maybeA.value
        return Effect.succeed(b)
      })
    }))
)

/**
 * @since 2.0.0
 * @category utils
 */
export const set: {
  <A>(value: A): (self: SynchronizedRef<A>) => Effect.Effect<void>
  <A>(self: SynchronizedRef<A>, value: A): Effect.Effect<void>
} = dual(
  2,
  <A>(self: SynchronizedRef<A>, value: A): Effect.Effect<void> =>
    self.semaphore.withPermit(Ref.set(self.backing, value))
)

/**
 * @since 2.0.0
 * @category utils
 */
export const setAndGet: {
  <A>(value: A): (self: SynchronizedRef<A>) => Effect.Effect<A>
  <A>(self: SynchronizedRef<A>, value: A): Effect.Effect<A>
} = dual(
  2,
  <A>(self: SynchronizedRef<A>, value: A): Effect.Effect<A> =>
    self.semaphore.withPermit(Ref.setAndGet(self.backing, value))
)

/**
 * @since 2.0.0
 * @category utils
 */
export const update: {
  <A>(f: (a: A) => A): (self: SynchronizedRef<A>) => Effect.Effect<void>
  <A>(self: SynchronizedRef<A>, f: (a: A) => A): Effect.Effect<void>
} = dual(
  2,
  <A>(self: SynchronizedRef<A>, f: (a: A) => A): Effect.Effect<void> =>
    self.semaphore.withPermit(Ref.update(self.backing, f))
)

/**
 * @since 2.0.0
 * @category utils
 */
export const updateEffect: {
  <A, R, E>(f: (a: A) => Effect.Effect<A, E, R>): (self: SynchronizedRef<A>) => Effect.Effect<void, E, R>
  <A, R, E>(self: SynchronizedRef<A>, f: (a: A) => Effect.Effect<A, E, R>): Effect.Effect<void, E, R>
} = dual(
  2,
  <A, R, E>(self: SynchronizedRef<A>, f: (a: A) => Effect.Effect<A, E, R>): Effect.Effect<void, E, R> =>
    self.semaphore.withPermit(Effect.suspend(() => {
      const value = getUnsafe(self)
      return Effect.map(f(value), (newValue) => {
        self.backing.ref.current = newValue
      })
    }))
)

/**
 * @since 2.0.0
 * @category utils
 */
export const updateAndGet: {
  <A>(f: (a: A) => A): (self: SynchronizedRef<A>) => Effect.Effect<A>
  <A>(self: SynchronizedRef<A>, f: (a: A) => A): Effect.Effect<A>
} = dual(
  2,
  <A>(self: SynchronizedRef<A>, f: (a: A) => A): Effect.Effect<A> =>
    self.semaphore.withPermit(Ref.updateAndGet(self.backing, f))
)

/**
 * @since 2.0.0
 * @category utils
 */
export const updateAndGetEffect: {
  <A, R, E>(f: (a: A) => Effect.Effect<A, E, R>): (self: SynchronizedRef<A>) => Effect.Effect<A, E, R>
  <A, R, E>(self: SynchronizedRef<A>, f: (a: A) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
} = dual(
  2,
  <A, R, E>(self: SynchronizedRef<A>, f: (a: A) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    self.semaphore.withPermit(Effect.suspend(() => {
      const value = getUnsafe(self)
      return Effect.map(f(value), (newValue) => {
        self.backing.ref.current = newValue
        return newValue
      })
    }))
)

/**
 * @since 2.0.0
 * @category utils
 */
export const updateSome: {
  <A>(f: (a: A) => Option.Option<A>): (self: SynchronizedRef<A>) => Effect.Effect<void>
  <A>(self: SynchronizedRef<A>, f: (a: A) => Option.Option<A>): Effect.Effect<void>
} = dual(
  2,
  <A>(self: SynchronizedRef<A>, f: (a: A) => Option.Option<A>): Effect.Effect<void> =>
    self.semaphore.withPermit(Ref.updateSome(self.backing, f))
)

/**
 * @since 2.0.0
 * @category utils
 */
export const updateSomeEffect: {
  <A, R, E>(
    pf: (a: A) => Effect.Effect<Option.Option<A>, E, R>
  ): (self: SynchronizedRef<A>) => Effect.Effect<void, E, R>
  <A, R, E>(self: SynchronizedRef<A>, pf: (a: A) => Effect.Effect<Option.Option<A>, E, R>): Effect.Effect<void, E, R>
} = dual(
  2,
  <A, R, E>(self: SynchronizedRef<A>, pf: (a: A) => Effect.Effect<Option.Option<A>, E, R>): Effect.Effect<void, E, R> =>
    self.semaphore.withPermit(Effect.suspend(() => {
      const value = getUnsafe(self)
      return Effect.map(pf(value), (option) => {
        if (Option.isNone(option)) {
          return
        }
        self.backing.ref.current = option.value
      })
    }))
)

/**
 * @since 2.0.0
 * @category utils
 */
export const updateSomeAndGet: {
  <A>(pf: (a: A) => Option.Option<A>): (self: SynchronizedRef<A>) => Effect.Effect<A>
  <A>(self: SynchronizedRef<A>, pf: (a: A) => Option.Option<A>): Effect.Effect<A>
} = dual(
  2,
  <A>(self: SynchronizedRef<A>, pf: (a: A) => Option.Option<A>): Effect.Effect<A> =>
    self.semaphore.withPermit(Ref.updateSomeAndGet(self.backing, pf))
)

/**
 * @since 2.0.0
 * @category utils
 */
export const updateSomeAndGetEffect: {
  <A, R, E>(pf: (a: A) => Effect.Effect<Option.Option<A>, E, R>): (self: SynchronizedRef<A>) => Effect.Effect<A, E, R>
  <A, R, E>(self: SynchronizedRef<A>, pf: (a: A) => Effect.Effect<Option.Option<A>, E, R>): Effect.Effect<A, E, R>
} = dual(
  2,
  <A, R, E>(self: SynchronizedRef<A>, pf: (a: A) => Effect.Effect<Option.Option<A>, E, R>): Effect.Effect<A, E, R> =>
    self.semaphore.withPermit(Effect.suspend(() => {
      const value = getUnsafe(self)
      return Effect.flatMap(pf(value), (option) => {
        if (Option.isNone(option)) {
          return Effect.succeed(value)
        }
        self.backing.ref.current = option.value
        return Effect.succeed(option.value)
      })
    }))
)
