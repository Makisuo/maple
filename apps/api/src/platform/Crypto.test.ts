import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { decryptAes256Gcm, encryptAes256Gcm, parseBase64Aes256GcmKey } from "./Crypto"

const fail = (message: string) => new Error(message)

describe("AES-256-GCM via Web Crypto", () => {
	it.effect("round-trips plaintext without AAD", () =>
		Effect.gen(function* () {
			const key = yield* parseBase64Aes256GcmKey(Buffer.alloc(32, 7).toString("base64"), fail)
			const encrypted = yield* encryptAes256Gcm("maple_sk_test", key, fail)
			const plaintext = yield* decryptAes256Gcm(encrypted, key, fail)
			assert.strictEqual(plaintext, "maple_sk_test")
			assert.isTrue(encrypted.iv.length > 0)
			assert.isTrue(encrypted.tag.length > 0)
		}),
	)

	it.effect("round-trips with AAD and rejects a mismatched AAD", () =>
		Effect.gen(function* () {
			const key = yield* parseBase64Aes256GcmKey(Buffer.alloc(32, 9).toString("base64"), fail)
			const aad = Buffer.from("org:default")
			const encrypted = yield* encryptAes256Gcm("secret", key, fail, aad)
			const plaintext = yield* decryptAes256Gcm(encrypted, key, fail, aad)
			assert.strictEqual(plaintext, "secret")

			const exit = yield* Effect.exit(decryptAes256Gcm(encrypted, key, fail, Buffer.from("org:other")))
			assert.isTrue(exit._tag === "Failure")
		}),
	)

	it.effect("rejects a non-32-byte encryption key", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(parseBase64Aes256GcmKey(Buffer.alloc(16, 1).toString("base64"), fail))
			assert.isTrue(exit._tag === "Failure")
		}),
	)
})
