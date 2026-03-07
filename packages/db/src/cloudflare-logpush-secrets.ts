import { createHmac } from "node:crypto";

export const parseCloudflareLogpushSecretHmacKey = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY is required");
  }

  return trimmed;
};

export const hashCloudflareLogpushSecret = (
  rawSecret: string,
  hmacKey: string,
): string =>
  createHmac("sha256", hmacKey).update(rawSecret, "utf8").digest("base64url");
