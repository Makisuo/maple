// Shape primitives shared by the archive journal and manifest readers.
//
// These are the rules that were genuinely copy-pasted: a non-negative safe
// integer was re-checked at four sites in the GC intent alone, and the sha256
// pattern at six across the two files. The rest of the archive parsers are
// domain invariants — path containment, phase-vs-kind compatibility, cursor
// consistency — each with its own tested message, and those stay where they
// are rather than being flattened into a struct declaration.
import { Schema, SchemaGetter } from "effect"

/** Byte counts and cursors: never negative, never beyond exact integer range. */
export const NonNegativeSafeInt = Schema.Number.check(
	Schema.makeFilter((value: number) =>
		Number.isSafeInteger(value) && value >= 0 ? undefined : "must be a safe non-negative integer",
	),
)

/**
 * A sha256 digest, normalized to lower case before it is compared.
 *
 * Case normalization is part of the rule, not a courtesy: these digests gate
 * whether a generation may be deleted, and an upper-case digest that failed to
 * compare equal would look like corruption of data that is in fact intact.
 */
export const Sha256Lower = Schema.String.pipe(
	Schema.decodeTo(Schema.String, {
		decode: SchemaGetter.transform((value: string) => value.toLowerCase()),
		encode: SchemaGetter.passthrough(),
	}),
).check(
	Schema.makeFilter((value: string) =>
		/^[0-9a-f]{64}$/.test(value) ? undefined : "must be 64 hex characters",
	),
)

export const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
