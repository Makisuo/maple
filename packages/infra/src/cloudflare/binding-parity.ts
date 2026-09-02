/**
 * Compile-time drift gate between a worker factory's declared bindings and the
 * runtime env type its worker code reads (the app's `src/worker-env.ts`).
 *
 * `Declared` is `Cloudflare.InferEnv` over the factory's binding map. The
 * constraint proves every declared binding satisfies the runtime type — a
 * retyped binding fails on the offending property — and the rest parameter
 * proves every key the worker knows is still declared: dropping one makes the
 * call demand an argument whose type names the missing keys.
 *
 * Purely a type assertion; the call does nothing at runtime.
 */
export const assertBindingParity = <Runtime, Declared extends Runtime>(
	..._proof: keyof Runtime extends keyof Declared
		? []
		: [{ undeclaredBindings: Exclude<keyof Runtime, keyof Declared> }]
): void => {}
