import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Sample tool that proves the tool loop end-to-end. Returns the current time,
 * optionally in a given IANA timezone (e.g. "America/New_York", "UTC").
 */
export default defineTool({
  description:
    "Get the current date and time. Optionally pass an IANA timezone (e.g. 'America/New_York', 'Europe/Berlin', 'UTC').",
  inputSchema: z.object({
    timezone: z
      .string()
      .optional()
      .describe("IANA timezone name. Defaults to UTC."),
  }),
  async execute({ timezone }) {
    const now = new Date();
    const tz = timezone ?? "UTC";
    try {
      const formatted = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        dateStyle: "full",
        timeStyle: "long",
      }).format(now);
      return { timezone: tz, iso: now.toISOString(), formatted };
    } catch {
      // Invalid timezone — fall back to UTC ISO rather than throwing.
      return {
        timezone: "UTC",
        iso: now.toISOString(),
        formatted: now.toISOString(),
        note: `Unknown timezone "${tz}", returned UTC instead.`,
      };
    }
  },
});
