import { Effect } from "effect"

export interface EncryptedValue {
	readonly ciphertext: string
	readonly iv: string
	readonly tag: string
}

const AES_GCM_TAG_BYTES = 16

const toBytes = (value: Buffer | Uint8Array): Uint8Array =>
	new Uint8Array(value.buffer, value.byteOffset, value.byteLength)

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64")

const fromBase64 = (raw: string): Uint8Array => new Uint8Array(Buffer.from(raw, "base64"))

const importAesGcmKey = (encryptionKey: Buffer, usage: KeyUsage) =>
	crypto.subtle.importKey("raw", toBytes(encryptionKey), { name: "AES-GCM" }, false, [usage])

const aesGcmParams = (iv: BufferSource, aad: Buffer | undefined): AesGcmParams => ({
	name: "AES-GCM",
	iv,
	tagLength: AES_GCM_TAG_BYTES * 8,
	...(aad !== undefined ? { additionalData: toBytes(aad) } : {}),
})

export const parseBase64Aes256GcmKey = <E>(raw: string, onError: (message: string) => E) =>
	Effect.try({
		try: () => {
			const trimmed = raw.trim()
			if (trimmed.length === 0) {
				throw new Error("Expected a non-empty base64 encryption key")
			}

			const decoded = Buffer.from(trimmed, "base64")
			if (decoded.length !== 32) {
				throw new Error("Expected base64 for exactly 32 bytes")
			}

			return decoded
		},
		catch: (error) => onError(error instanceof Error ? error.message : "Invalid encryption key"),
	})

/**
 * Optional additional authenticated data. AAD is authenticated but not stored,
 * so it binds a ciphertext to the row it was written for: decryption only
 * succeeds when the caller reconstructs the exact same bytes. Omitting it keeps
 * the original (AAD-free) format — existing ciphertexts written without one must
 * keep decrypting, so callers may only start passing an `aad` for columns with
 * no live rows.
 *
 * Implemented with Web Crypto (`crypto.subtle`) rather than `node:crypto`
 * `createCipheriv`. celld/workerd's nodejs_compat HMAC works; AES-GCM through
 * `createCipheriv` does not, which 500'd `GET /v2/ingest_keys` on self-host.
 * The stored `{ciphertext,iv,tag}` layout is unchanged, so Cloud-written rows
 * still decrypt.
 */
export const encryptAes256Gcm = <E>(
	plaintext: string,
	encryptionKey: Buffer,
	onError: (message: string) => E,
	aad?: Buffer,
) =>
	Effect.tryPromise({
		try: async () => {
			const iv = crypto.getRandomValues(new Uint8Array(12))
			const key = await importAesGcmKey(encryptionKey, "encrypt")
			const bundled = new Uint8Array(
				await crypto.subtle.encrypt(
					aesGcmParams(iv, aad),
					key,
					new TextEncoder().encode(plaintext),
				),
			)
			if (bundled.byteLength < AES_GCM_TAG_BYTES) {
				throw new Error("AES-GCM encrypt returned a truncated payload")
			}
			const tag = bundled.subarray(bundled.byteLength - AES_GCM_TAG_BYTES)
			const ciphertext = bundled.subarray(0, bundled.byteLength - AES_GCM_TAG_BYTES)
			return {
				ciphertext: toBase64(ciphertext),
				iv: toBase64(iv),
				tag: toBase64(tag),
			} satisfies EncryptedValue
		},
		catch: (error) => onError(error instanceof Error ? error.message : "Encryption failed"),
	})

/** Counterpart to {@link encryptAes256Gcm} — `aad` must match the value used to encrypt. */
export const decryptAes256Gcm = <E>(
	encrypted: EncryptedValue,
	encryptionKey: Buffer,
	onError: (message: string) => E,
	aad?: Buffer,
) =>
	Effect.tryPromise({
		try: async () => {
			const iv = fromBase64(encrypted.iv)
			const ciphertext = fromBase64(encrypted.ciphertext)
			const tag = fromBase64(encrypted.tag)
			const bundled = new Uint8Array(ciphertext.byteLength + tag.byteLength)
			bundled.set(ciphertext, 0)
			bundled.set(tag, ciphertext.byteLength)
			const key = await importAesGcmKey(encryptionKey, "decrypt")
			const plaintext = await crypto.subtle.decrypt(aesGcmParams(iv, aad), key, bundled)
			return new TextDecoder().decode(plaintext)
		},
		catch: () => onError("Decryption failed"),
	})
