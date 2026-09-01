import { Option, Schema } from "effect"

/**
 * URL parsing as a value, shared so no caller has to reach for `new URL(...)` in
 * a `try`.
 *
 * `Schema.URLFromString` is the Effect-level primitive for this: it reports the
 * failure as a value instead of a thrown exception, and `decodeUnknownOption`
 * keeps the result synchronous and total, so these stay plain functions that a
 * predicate, an HTTP handler and a test can all call directly. A thrown
 * `TypeError` is invisible to the type system, and the `catch` that answers it
 * flattens "not a URL" together with every other failure in the block.
 */
const decodeUrl = Schema.decodeUnknownOption(Schema.URLFromString)

/** A string to a `URL`, or `Option.none` when it is not one. */
export const parseUrl = (input: string): Option.Option<URL> => decodeUrl(input)

/**
 * A string to a `URL`, resolved against `base`, or `Option.none` when the pair
 * does not make one.
 *
 * The relative form of {@link parseUrl}. `Schema.URLFromString` takes no base,
 * so this is the one place the constructor is called — kept total by checking
 * the base first and treating a rejected pair as absence, the same answer the
 * absolute form gives.
 */
export const parseUrlWithBase = (input: string, base: URL | string): Option.Option<URL> => {
	const resolvedBase = typeof base === "string" ? parseUrl(base) : Option.some(base)
	if (Option.isNone(resolvedBase)) return Option.none()
	// Guarded by `canParse`, so the constructor cannot throw — the same total
	// contract the schema gives for the absolute form.
	if (!URL.canParse(input, resolvedBase.value)) return Option.none()
	return Option.some(new URL(input, resolvedBase.value))
}

/**
 * The pathname of a URL, or `""` when the string is not one.
 *
 * The shape every request predicate wants: an unparseable URL has no path, so it
 * matches no route, which is what each of those `catch { return false }` blocks
 * was spelling out by hand.
 */
export const urlPathname = (input: string): string =>
	Option.match(parseUrl(input), { onNone: () => "", onSome: (url) => url.pathname })
