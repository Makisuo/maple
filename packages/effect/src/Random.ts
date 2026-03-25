/**
 * The Random module provides a service for generating random numbers in Effect
 * programs. It offers a testable and composable way to work with randomness,
 * supporting integers, floating-point numbers, and range-based generation.
 *
 * @example
 * ```ts
 * import { Effect, Random } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const randomFloat = yield* Random.next
 *   console.log("Random float:", randomFloat)
 *
 *   const randomInt = yield* Random.nextInt
 *   console.log("Random integer:", randomInt)
 *
 *   const diceRoll = yield* Random.nextIntBetween(1, 6)
 *   console.log("Dice roll:", diceRoll)
 * })
 * ```
 *
 * @since 4.0.0
 */
import * as Effect from "./Effect.ts"
import { dual } from "./Function.ts"
import * as random from "./internal/random.ts"
import * as Predicate from "./Predicate.ts"
import type * as ServiceMap from "./ServiceMap.ts"

/**
 * Represents a service for generating random numbers.
 *
 * @example
 * ```ts
 * import { Effect, Random } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const float = yield* Random.next
 *   const integer = yield* Random.nextInt
 *   const inRange = yield* Random.nextIntBetween(1, 100)
 *   const uuid = yield* Random.nextUUIDv4
 *
 *   console.log("Float:", float)
 *   console.log("Integer:", integer)
 *   console.log("In range:", inRange)
 *   console.log("UUID:", uuid)
 * })
 * ```
 *
 * @since 4.0.0
 * @category Random Number Generators
 */
export const Random: ServiceMap.Reference<{
  nextIntUnsafe(): number
  nextDoubleUnsafe(): number
}> = random.Random

const randomWith = <A>(f: (random: typeof Random["Service"]) => A): Effect.Effect<A> =>
  Effect.withFiber((fiber) => Effect.succeed(f(fiber.getRef(Random))))

/**
 * Generates a random number between 0 (inclusive) and 1 (inclusive).
 *
 * @example
 * ```ts
 * import { Effect, Random } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const randomDouble = yield* Random.next
 *   console.log("Random double:", randomDouble)
 * })
 * ```
 *
 * @since 4.0.0
 * @category Random Number Generators
 */
export const next: Effect.Effect<number> = randomWith((r) => r.nextDoubleUnsafe())

/**
 * Generates a random boolean value.
 *
 * @example
 * ```ts
 * import { Effect, Random } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const value = yield* Random.nextBoolean
 *   console.log("Random boolean:", value)
 * })
 * ```
 *
 * @since 4.0.0
 * @category Random Number Generators
 */
export const nextBoolean: Effect.Effect<boolean> = randomWith((r) => r.nextDoubleUnsafe() > 0.5)

/**
 * Generates a random integer between `Number.MIN_SAFE_INTEGER` (inclusive)
 * and `Number.MAX_SAFE_INTEGER` (inclusive).
 *
 * @example
 * ```ts
 * import { Effect, Random } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const randomInt = yield* Random.nextInt
 *   console.log("Random integer:", randomInt)
 * })
 * ```
 *
 * @since 4.0.0
 * @category Random Number Generators
 */
export const nextInt: Effect.Effect<number> = randomWith((r) => r.nextIntUnsafe())

/**
 * Generates a random number between `min` (inclusive) and `max` (inclusive).
 *
 * @example
 * ```ts
 * import { Effect, Random } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const randomDouble = yield* Random.nextBetween(0, 1)
 *   console.log("Random double: ", randomDouble)
 * })
 * ```
 *
 * @since 4.0.0
 * @category Random Number Generators
 */
export const nextBetween = (min: number, max: number): Effect.Effect<number> =>
  randomWith((r) => r.nextDoubleUnsafe() * (max - min) + min)

/**
 * Generates a random number between `min` (inclusive) and `max` (inclusive).
 *
 * Set `options.halfOpen: true` to generate in the half-open range
 * `[min, max)`.
 *
 * @example
 * ```ts
 * import { Effect, Random } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const diceRoll1 = yield* Random.nextIntBetween(1, 6)
 *   const diceRoll2 = yield* Random.nextIntBetween(1, 6, {
 *     halfOpen: true
 *   })
 *   const diceRoll3 = yield* Random.nextIntBetween(0, 10)
 * })
 * ```
 *
 * @since 4.0.0
 * @category Random Number Generators
 */
export const nextIntBetween = (min: number, max: number, options?: {
  readonly halfOpen?: boolean
}): Effect.Effect<number> => {
  const extra = options?.halfOpen === true ? 0 : 1
  return randomWith((r) => {
    const minInt = Math.ceil(min)
    const maxInt = Math.floor(max)
    return Math.floor(r.nextDoubleUnsafe() * (maxInt - minInt + extra)) + minInt
  })
}

/**
 * Uses the pseudo-random number generator to shuffle the specified iterable.
 *
 * @example
 * ```ts
 * import { Effect, Random } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const values = yield* Random.shuffle([1, 2, 3, 4, 5])
 *   console.log(values)
 * })
 * ```
 *
 * @since 4.0.0
 * @category Random Number Generators
 */
export const shuffle = <A>(elements: Iterable<A>): Effect.Effect<Array<A>> =>
  randomWith((r) => {
    const buffer = Array.from(elements)
    for (let i = buffer.length - 1; i >= 1; i = i - 1) {
      const index = Math.min(i, Math.floor(r.nextDoubleUnsafe() * (i + 1)))
      const value = buffer[i]!
      buffer[i] = buffer[index]!
      buffer[index] = value
    }
    return buffer
  })

/**
 * Generates a random UUID (v4) string.
 *
 * @example
 * ```ts
 * import { Effect, Random } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const uuid = yield* Random.nextUUIDv4
 *   console.log("UUID:", uuid)
 * })
 * ```
 *
 * @since 4.0.0
 * @category Random Number Generators
 */
export const nextUUIDv4: Effect.Effect<string> = randomWith((r) => {
  // Generate 16 random bytes (128 bits) for UUID
  const bytes: Array<number> = []
  for (let i = 0; i < 16; i++) {
    // Get unsigned byte [0, 255] from nextInt (signed 32-bit)
    bytes.push((r.nextIntUnsafe() >>> 0) & 0xFF)
  }

  // Set version to 4 (bits 12-15 of time_hi_and_version)
  bytes[6] = (bytes[6] & 0x0F) | 0x40

  // Set variant to RFC 4122 (bits 6-7 of clock_seq_hi_and_reserved)
  bytes[8] = (bytes[8] & 0x3F) | 0x80

  // Format as UUID string: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  const hex = (n: number) => n.toString(16).padStart(2, "0")

  return [
    bytes.slice(0, 4).map(hex).join(""),
    bytes.slice(4, 6).map(hex).join(""),
    bytes.slice(6, 8).map(hex).join(""),
    bytes.slice(8, 10).map(hex).join(""),
    bytes.slice(10, 16).map(hex).join("")
  ].join("-")
})

/**
 * Seeds the pseudorandom number generator with the specified value.
 *
 * Take care to select a seed wit hhigh entropy to avoid issues with the
 * quality of random number generation.
 *
 * @example
 * ```ts
 * import { Effect, Random } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const value1 = yield* Random.next
 *   const value2 = yield* Random.next
 *   console.log(value1, value2)
 * })
 *
 * // Same seed produces same sequence
 * const seeded1 = program.pipe(Random.withSeed("my-seed"))
 * const seeded2 = program.pipe(Random.withSeed("my-seed"))
 *
 * // Both will output identical values
 * Effect.runPromise(seeded1)
 * Effect.runPromise(seeded2)
 * ```
 *
 * @since 4.0.0
 * @category Seeding
 */
export const withSeed: {
  (seed: string | number): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(self: Effect.Effect<A, E, R>, seed: string | number): Effect.Effect<A, E, R>
} = dual(2, <A, E, R>(
  self: Effect.Effect<A, E, R>,
  seed: string | number
) => Effect.provideService(self, Random, ISAAC_CSPRNG(seed)))

/*///////////////////////////////////////////////////////////////////////////////////////////////////
This is a derivative work copyright (c) 2025 Effectful Technologies Inc, under MIT license.
This is a derivative work copyright (c) 2018, William P. "Mac" McMeans, under BSD license.
Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of isaacCSPRNG nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
Original work copyright (c) 2012 Yves-Marie K. Rinquin, under MIT license.
https://github.com/rubycon/isaac.js
///////////////////////////////////////////////////////////////////////////////////////////////////*/
function ISAAC_CSPRNG(userSeed?: string | number) {
  // Internal State
  const memory = new Array(256)
  const result = new Array(256)
  let accumulator = 0
  let lastResult = 0
  let generation = 0
  let counter = 0

  // Initial Seed
  const internalSeed = Predicate.isUndefined(userSeed) ? getInitialSeed() : userSeed
  seed(internalSeed)

  function getInitialSeed() {
    const uint32a = new Uint32Array(2)
    crypto.getRandomValues(uint32a)
    return uint32a[0] + uint32a[1]
  }

  function reset() {
    accumulator = 0
    lastResult = 0
    counter = 0
    for (let i = 0; i < 256; ++i) {
      memory[i] = 0
      result[i] = 0
    }
    generation = 0
  }

  function seed(userSeed: string | number): void {
    // The golden ratio ( 2654435769 )
    // See https://stackoverflow.com/questions/4948780/magic-number-in-boosthash-combine
    const magicNumber = 0x9e3779b9
    let a = magicNumber
    let b = magicNumber
    let c = magicNumber
    let d = magicNumber
    let e = magicNumber
    let f = magicNumber
    let g = magicNumber
    let h = magicNumber
    let i = 0

    let seed: Array<number>
    if (Predicate.isString(userSeed)) {
      seed = toIntArray(userSeed)
    } else {
      seed = [userSeed]
    }

    reset()

    for (i = 0; i < seed.length; i++) {
      result[i & 0xff] += seed[i]
    }

    function mix() {
      a ^= b << 11
      d = add32(d, a)
      b = add32(b, c)

      b ^= c >>> 2
      e = add32(e, b)
      c = add32(c, d)

      c ^= d << 8
      f = add32(f, c)
      d = add32(d, e)

      d ^= e >>> 16
      g = add32(g, d)
      e = add32(e, f)

      e ^= f << 10
      h = add32(h, e)
      f = add32(f, g)

      f ^= g >>> 4
      a = add32(a, f)
      g = add32(g, h)

      g ^= h << 8
      b = add32(b, g)
      h = add32(h, a)

      h ^= a >>> 9
      c = add32(c, h)
      a = add32(a, b)
    }

    // Scramble the seed
    for (i = 0; i < 4; i++) {
      mix()
    }

    for (i = 0; i < 256; i += 8) {
      // Use all the information in the seed
      a = add32(a, result[i])
      b = add32(b, result[i + 1])
      c = add32(c, result[i + 2])
      d = add32(d, result[i + 3])
      e = add32(e, result[i + 4])
      f = add32(f, result[i + 5])
      g = add32(g, result[i + 6])
      h = add32(h, result[i + 7])

      mix()

      // Fill in the memory with messy stuff
      memory[i] = a
      memory[i + 1] = b
      memory[i + 2] = c
      memory[i + 3] = d
      memory[i + 4] = e
      memory[i + 5] = f
      memory[i + 6] = g
      memory[i + 7] = h
    }

    // Second pass to make sure seed affects memory
    for (i = 0; i < 256; i += 8) {
      a = add32(a, memory[i])
      b = add32(b, memory[i + 1])
      c = add32(c, memory[i + 2])
      d = add32(d, memory[i + 3])
      e = add32(e, memory[i + 4])
      f = add32(f, memory[i + 5])
      g = add32(g, memory[i + 6])
      h = add32(h, memory[i + 7])

      mix()

      // Fill in the memory with messy stuff (again)
      memory[i] = a
      memory[i + 1] = b
      memory[i + 2] = c
      memory[i + 3] = d
      memory[i + 4] = e
      memory[i + 5] = f
      memory[i + 6] = g
      memory[i + 7] = h
    }

    pnrg()

    generation = 256
  }

  function pnrg(n?: number): void {
    let i = 0
    let x = 0
    let y = 0

    n = Predicate.isUndefined(n) ? 1 : Math.abs(Math.floor(n))

    while (n--) {
      counter = add32(counter, 1)
      lastResult = add32(lastResult, counter)

      for (i = 0; i < 256; i++) {
        switch (i & 3) {
          case 0: {
            accumulator ^= accumulator << 13
            break
          }
          case 1: {
            accumulator ^= accumulator >>> 6
            break
          }
          case 2: {
            accumulator ^= accumulator << 2
            break
          }
          case 3: {
            accumulator ^= accumulator >>> 16
            break
          }
        }

        accumulator = add32(memory[(i + 128) & 0xff], accumulator)
        x = memory[i]

        memory[i] = add32(memory[(x >>> 2) & 0xff], add32(accumulator, lastResult))
        y = memory[i]

        result[i] = add32(memory[(y >>> 10) & 0xff], x)
        lastResult = result[i]
      }
    }
  }

  /**
   * Returns a signed, random integer in the range [-2^31, 2^31].
   */
  function nextInt32(): number {
    if (!generation--) {
      pnrg()
      generation = 255
    }
    return result[generation]
  }

  function nextIntUnsafe(): number {
    // Get 32 bits (unsigned)
    const low = nextInt32() >>> 0 // [0, 2^32-1]

    // Get 21 more bits for a total of 53
    const high = nextInt32() & 0x1FFFFF // [0, 2^21-1]

    // Combine: high bits * 2^32 + low bits, then shift to signed range
    // This gives [0, 2^53-1], subtract 2^52 to center around 0
    return (high * 0x100000000) + low - 0x10000000000000
  }

  /**
   * Returns a 53-bit fraction in the range [0, 1).
   */
  function nextDoubleUnsafe(): number {
    const hi = (nextInt32() >>> 0) & 0x1FFFFF // take top 21 bits
    const lo = nextInt32() >>> 0 // full 32 bits

    // 53-bit integer
    const combined = hi * 4294967296 + lo

    return combined / 9007199254740991 // [0, 1)
  }

  return { nextIntUnsafe, nextDoubleUnsafe }
}

/**
 * 32-bit addition with overflow handling (JavaScript numbers are 53-bit).
 *
 * Example: add32(0xFFFFFFFF, 0x00000001) = 0x00000000 (wraps around)
 */
function add32(x: number, y: number): number {
  // Add lower 16 bits separately to handle carry
  // Example: x=0x12345678, y=0xABCDEF01
  // lsb = (0x5678 + 0xEF01) = 0x14579
  const lsb = (x & 0xffff) + (y & 0xffff)

  // Add upper 16 bits + carry from lower addition
  // msb = (0x1234 + 0xABCD + (0x14579 >>> 16)) = (0x1234 + 0xABCD + 0x1) = 0xBE02
  const msb = (x >>> 16) + (y >>> 16) + (lsb >>> 16)

  // Combine: upper 16 bits | lower 16 bits (masked to prevent double carry)
  // return (0xBE02 << 16) | (0x14579 & 0xffff) = 0xBE024579
  return (msb << 16) | (lsb & 0xffff)
}

/**
 * Convert a UTF-16 strings to UTF-8 encoded 32-bit integers (little-endian).
 */
function toIntArray(seed: string): Array<number> {
  let c1 = 0 // First UTF-16 code unit
  let c2 = 0 // Second UTF-16 code unit (for surrogate pairs)
  let unicode = 0 // Combined unicode code point from surrogate pair
  const result: Array<number> = [] // Result array of 32-bit integers
  const buffer: Array<number> = [] // Temporary buffer for the UTF-8 bytes (max 4 bytes)
  const length = seed.length - 1

  let index = 0
  while (index < length) {
    c1 = seed.charCodeAt(index++)
    c2 = seed.charCodeAt(index + 1)

    // 0x0000 - 0x007f: ASCII, single byte UTF-8: 0xxxxxxxx
    // Example: 'A' (0x41) -> [0x41]
    if (c1 < 0x0080) {
      buffer.push(c1)
    } //
    // 0x0080 - 0x07ff: Two byte UTF-8: 110xxxxx 10xxxxxx
    // Example: '¢' (0xA2) -> [0xC2, 0xA2]
    else if (c1 < 0x0800) {
      // First byte: upper 5 bits + 110xxxxx marker
      // 0xA2 >>> 6 (0x02), & 0x1f = 0x02, | 0xc0 = 0xC2
      buffer.push(((c1 >>> 6) & 0x1f) | 0xc0)
      // Second byte: lower 6 bits + 10xxxxxxxx marker
      // 0xA2 & 0x3f = 0x22, | 0x80 = 0xA2
      buffer.push(((c1 >>> 0) & 0x3f) | 0x80)
    } //
    // 0x0800 - 0xffff (non-surrogate): Three byte UTF-8: 1110xxxx 10xxxxxx 10xxxxxx
    // Example: '€' (0x20AC) -> [0xE2, 0x82, 0xAC]
    else if ((c1 & 0xf800) != 0xd800) {
      // First byte: top 4 bits + 1110xxxx marker
      // 0x20AC >>> 12 = 0x02, & 0x0f = 0x02, | 0xe0 = 0xE2
      buffer.push(((c1 >>> 12) & 0x0f) | 0xe0)
      // Second byte: middle 6 bits + 10xxxxxx marker
      // 0x20AC >>> 6 = 0x82, & 0x3f = 0x02, | 0x80 = 0x82
      buffer.push(((c1 >>> 6) & 0x3f) | 0x80)
      // Third byte: lower 6 bits + 10xxxxxx marker
      // 0x20AC & 0x3f = 0x2C, | 0x80 = 0xAC
      buffer.push(((c1 >>> 0) & 0x3f) | 0x80)
    } //
    // 0xd800 - 0xdfff: Surrogate pairs, four byte UTF-8: 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx
    // Example: '𐍈' (U+10348, surrogates 0xD800 0xDF48) -> [0xF0, 0x90, 0x8D, 0x88]
    else if (((c1 & 0xfc00) == 0xd800) && ((c2 & 0xfc00) == 0xdc00)) {
      // Decode surrogate pair: combine 10 bits from each + 0x10000
      // ((0xDF48 & 0x3f) | ((0xD800 & 0x3f) << 10)) + 0x10000 = 0x10348
      unicode = ((c2 & 0x3f) | ((c1 & 0x3f) << 10)) + 0x10000
      // First byte: top 3 bits + 11110xxx marker
      // 0x10348 >>> 18 = 0x00, & 0x07 = 0x00, | 0xf0 = 0xF0
      buffer.push(((unicode >>> 18) & 0x07) | 0xf0)
      // Second byte: next 6 bits + 10xxxxxx marker
      // 0x10348 >>> 12 = 0x10, & 0x3f = 0x10, | 0x80 = 0x90
      buffer.push(((unicode >>> 12) & 0x3f) | 0x80)
      // Third byte: next 6 bits + 10xxxxxx marker
      // 0x10348 >>> 6 = 0x40D, & 0x3f = 0x0D, | 0x80 = 0x8D
      buffer.push(((unicode >>> 6) & 0x3f) | 0x80)
      // Fourth byte: lower 6 bits + 10xxxxxx marker
      // 0x10348 & 0x3f = 0x08, | 0x80 = 0x88
      buffer.push(((unicode >>> 0) & 0x3f) | 0x80)
      index++ // Skip second surrogate
    } else {
      // invalid char
    }

    // Pack 4 UTF-8 bytes -> 32-bit int (little-endian)
    // Example: [0xE2, 0x82, 0xAC, 0x00] -> 0x00ACE2E2
    if (buffer.length > 3) {
      result.push(
        (buffer.shift()! << 0) | // Byte 0 at bits 0-7:   0xE2 << 0  = 0x000000E2
          (buffer.shift()! << 8) | // Byte 1 at bits 8-15:  0x82 << 8  = 0x00008200
          (buffer.shift()! << 16) | // Byte 2 at bits 16-23: 0xAC << 16 = 0x00AC0000
          (buffer.shift()! << 24) // Byte 3 at bits 24-31: 0x00 << 24 = 0x00000000
      )
      // Result: 0x00AC82E2
    }
  }

  return result
}
