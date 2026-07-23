import { defineDynamic, defineInstructions } from "eve/instructions";
import { mapleAppBaseUrl } from "#lib/maple.js";

/**
 * Injects the Maple web-app base URL so the model can build absolute deep
 * links (`<https://app.maple.dev/traces/<id>|view trace>`) in Slack replies.
 * The value is env-derived (`MAPLE_APP_BASE_URL`), so it cannot live in the
 * static instructions.md — chat-flue never needed this because the web UI was
 * the host and links could be relative.
 */
export default defineDynamic({
  events: {
    "session.started": () =>
      defineInstructions({
        markdown:
          `The Maple app base URL for deep links is ${mapleAppBaseUrl()} — ` +
          "combine it with the detail routes listed under “Linking into Maple”.",
      }),
  },
});
