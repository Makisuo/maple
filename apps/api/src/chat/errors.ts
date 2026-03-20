import { Schema } from "effect"

export class InvalidChatRequestError extends Schema.TaggedErrorClass<InvalidChatRequestError>()(
  "InvalidChatRequestError",
  {
    message: Schema.String,
  },
) {}

export class ChatConfigurationError extends Schema.TaggedErrorClass<ChatConfigurationError>()(
  "ChatConfigurationError",
  {
    message: Schema.String,
  },
) {}

export class ChatToolFailure extends Schema.TaggedErrorClass<ChatToolFailure>()(
  "ChatToolFailure",
  {
    message: Schema.String,
    details: Schema.optional(Schema.Array(Schema.String)),
  },
) {}
