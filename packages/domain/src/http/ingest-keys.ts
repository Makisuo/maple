import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { IsoDateTimeString } from "../primitives"
import { Authorization } from "./current-tenant"

export class IngestKeysResponse extends Schema.Class<IngestKeysResponse>("IngestKeysResponse")({
  publicKey: Schema.String,
  privateKey: Schema.String,
  publicRotatedAt: IsoDateTimeString,
  privateRotatedAt: IsoDateTimeString,
}) {}

export class IngestKeyPersistenceError extends Schema.TaggedErrorClass<IngestKeyPersistenceError>()(
  "@maple/http/errors/IngestKeyPersistenceError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {}

export class IngestKeyEncryptionError extends Schema.TaggedErrorClass<IngestKeyEncryptionError>()(
  "@maple/http/errors/IngestKeyEncryptionError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

export class IngestKeysApiGroup extends HttpApiGroup.make("ingestKeys")
  .add(
    HttpApiEndpoint.get("get", "/", {
      success: IngestKeysResponse,
      error: [IngestKeyPersistenceError, IngestKeyEncryptionError],
    }),
  )
  .add(
    HttpApiEndpoint.post("rerollPublic", "/public/reroll", {
      success: IngestKeysResponse,
      error: [IngestKeyPersistenceError, IngestKeyEncryptionError],
    }),
  )
  .add(
    HttpApiEndpoint.post("rerollPrivate", "/private/reroll", {
      success: IngestKeysResponse,
      error: [IngestKeyPersistenceError, IngestKeyEncryptionError],
    }),
  )
  .prefix("/api/ingest-keys")
  .middleware(Authorization) {}
